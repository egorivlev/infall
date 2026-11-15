# Infall UI — build brief for M1

> The product is called **Infall** in everything a person reads (the code, packages and design file names still say qoop).

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
- Grid: top bar 66px across the top (two rows, see "Top bar, two rows" below); left rail 224px; the rest is the work area. Min window 1280px wide; no mobile layout, but nothing may overflow horizontally at 1280.
- Top bar (see `QTopBar`): logo + "Infall"; Branch pill showing `main` (mono, 600) — in M1 it is display-only (no switcher menu; `title="Branches arrive in a later version"` is not needed, just make it non-interactive text in a bordered pill); search field "Search Cards" with ⌘K hint that filters Cards by title/summary and jumps to the chosen one; presence avatars ("On main" label + overlapping 24px circles with initials, `title` = name); theme toggle; account menu (name, role, "Sign out"; Admins also get "Members").
- Rail (see `QRail`): nav item "Board" (active) and, for Admins, "Members"; a "Frames" section listing each Frame with its Card count — click jumps the Board to that Frame; "+" adds a Frame; footer shows sync state from `useBoard().status`: "Synced" (green dot) / "Reconnecting…" (amber) / "Offline" and the host name.
- Do **not** show History, Checkpoint, To-dos, Suggestions, Sources or AI controls — they do not exist yet.

## Board (see `QBoardCanvas`, `Qoop Board` 1a/1b)
- Pan: drag empty space or two-finger scroll. Zoom: wheel/pinch, 10–200%, plus a small HUD bottom-right with −, %, +, "Fit". Dot grid 24px in `--q-grid`.
- Semantic zoom: ≥55% full Card; 30–55% compact (title + status glyph/short word, no summary); <30% tile (status-tinted block with glyph only; Connection labels hidden). Frame titles scale up as you zoom out so they stay legible.
- **Card** 224×132, radius 5, `--q-raised`, 1px `--q-line`; padding 9/11/8. Top row: status glyph + status word (mono 9.5px caps). Title 13/600/1.3 (2-line clamp). Summary 11.5/1.38 (2-line clamp), `--q-ink-2`. Selected: accent border + 2px `--q-accent-soft` ring.
- **Frame**: 1px `--q-line-soft` box, radius 8, faint fill, title above its top-left in sans 15/600 + Card count in mono. Membership is geometric (a Card whose centre is inside the Frame counts). Frames sit behind Cards.
- **Connection**: cubic curve between Card edge midpoints; 1.2px `--q-ink-3` at 60% opacity, full opacity `--q-ink-2` when touching the selected Card. `directed` → open chevron arrowhead at the `to` end; `contradicts` → short perpendicular bar cap at both ends; `related` → plain. Label chip at the midpoint: mono 10.5/500, `--q-canvas` background, 1px `--q-line-soft`, radius 3.

### Interactions (not in the mock-ups — these are the rules)
- Double-click empty space → new Card there (status `idea`), title immediately editable. Also a "+ Card" button in a small toolbar top-left of the Board, and "+ Frame" (creates a 520×360 Frame). Both put the new thing in free space nearest the viewport centre (`place.ts`): clear by 24 units of every Card, Frame title and Connection label, and not inside a Frame unless the whole view is inside that Frame (then inside it, never across its edge), tried outward on a grid of a quarter of its size, then with steps twice as long each time until a free place turns up (a Board seen from far out, tiled with Frames, puts it beyond them); the view follows it if it lands out of sight.
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
- Login: centred 380px card on `--q-sunken`: logo, serif "Sign in to Infall", Email, Password, "Sign in". Under it: "Forgot your password? Ask your Admin." Errors appear inline under the form, in plain words ("That email and password don't match." / "Too many attempts. Try again in a few minutes."). No sign-up link — accounts are by invite only.
- Accept invite (`/invite/<token>`): looks up the invite; shows "You're invited as a Member/Guest — <email>"; fields Name, Password (min 12, with the rule stated up front, not only on error), "Join Infall". Expired/used invite → a calm full-card message "This invite is no longer valid. Ask your Admin for a new one."
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
- **Branch pill → switcher** (`QTopBar` lines 20–45): a real `<button aria-haspopup="menu">` labelled "BRANCH <name>"; opens a 320px menu: section label "Branches", one row per Branch (name in mono 600 — `main` in ink, others in `--q-branch`; under it a meta line in `--q-ink-3`: "default Branch" for main, else "from <parent Branch name> · <creator first name> · <date>"; "✓" on the current one), a divider, then "New Branch…" (M15b; was "New Branch from now…") and "All Branches…" (both go to `/branches`; the first selects the newest dot of the open Branch on the Branch Graph and focuses the name field). Arrow keys move, Enter chooses, Esc closes and returns focus. Choosing a Branch navigates to its route.
- **Checkpoint** button (diamond icon + "Checkpoint", title "Name this moment of the Branch"): opens a small popover with one labelled field "Checkpoint name", placeholder "e.g. Before decoder rewrite", buttons "Create Checkpoint" (primary) and "Cancel". Enter submits. On success: close and toast-free confirmation inline is not needed — the button briefly reads "◆ Created" for 2 s (aria-live polite). `409 name_taken` → inline "This Branch already has a Checkpoint with that name." Other failures → inline plain sentence.
- **History** button (clock icon + "History", `aria-pressed`): calls `historyPanel.toggle()` from `ui/bridge`; pressed look (`--q-hover` background, `--q-line` border) while open. If the Board is not showing, go to the Board first.

## Branches screen (`/branches`, 8a)
> Replaced in M15b by the Branch Graph (see "M15b — the Branch Graph" at the end); the table and the New Branch panel below are gone. Kept for the record.

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
- Since M15b these are on each Branch's label on the Branch Graph.
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


---

# M4 — Pages, Sources, To-dos

Design source: `design/QPage.dc.html` (the Page — match its typography and spacing), `design/Qoop Page.dc.html` screens 3a (Page as a side panel over the live Board) and 3c (soft lock), `design/Qoop Team.dc.html` screen 6a (To-dos). Data layer: [CONTRACT.md](../lib/CONTRACT.md) "M4". Vocabulary: Page, block, Source, To-do, Card. Never "article", "document", "note", "link", "reference", "citation", "task", "ticket".
Not in M4 (do not show): Visual and Run blocks, image blocks, AI-generated/pinned blocks, "Ask to hand over", fetching Source details from the web.

## Opening a Page (Board)
- A Card with a Page or Sources shows a quiet footer row at full zoom: "¶ 4" (blocks) and "3 Sources" in mono 9.5 `--q-ink-3`.
- Open the Page of a Card: the "Open Page" button in the inspector (primary action at its top), double-click on the Card outside its title/summary, or `O` with one Card selected. This calls `pagePanel.open(id)` (`ui/bridge`). The inspector is hidden while the Page panel shows that Card.
- Not available while previewing History (close the panel when a preview starts).

## Page panel (3a)
- Docked to the right edge of the Board area, 740px wide (min 480; never wider than the area minus 320), full height, `--q-surface`, 1px `--q-line` left border, own scroll; the Board stays live and usable beside it. "⤢" toggles full width of the Board area (`pagePanel.toggleFull()`); "✕" and Esc (when focus is in the panel and nothing is being edited) close it. Focus moves to the panel heading on open and back to the Card on close.
- **Header row** (sticky): "Frame: <name>" (if the Card sits in a Frame) › "Page"; the status picker (reuse the Board's status menu); spacer; sync text ("Synced" / "Syncing…" from `useBoard().pending`, or "Read-only"); ⤢; ✕.
- **Body** (max 620px column, serif 16/1.6 for prose like the mock-up): `<h1>` title (Source Serif 28/600, click to edit in place — same rules as on the Card); a meta row in mono 11 `--q-ink-3`: "N blocks · N Sources · N Connections".
- **Blocks**: each Block renders its Markdown. Supported, and nothing else: `#`/`##`/`###` headings, paragraphs, `**bold**`, `*italic*`, `` `code` ``, fenced code blocks, `-`/`1.` lists, `> ` quotes, `[text](https://…)` links (http/https only, `rel="noreferrer noopener" target="_blank"`), inline math `$…$` and display math `$$…$$` on its own lines rendered with KaTeX (already a dependency; `throwOnError: false`, `trust: false`; load its CSS). Write a small renderer that produces React elements — no raw HTML passthrough, no `dangerouslySetInnerHTML` except for KaTeX's own output. Unknown syntax shows as plain text.
- **Editing a Block**: click it (or Enter when focused) → it becomes an auto-growing `<textarea>` with the Markdown source, mono 13; a small hint line under it "Markdown · $math$ · ⌘Enter to finish · Esc to cancel". Blur or ⌘/Ctrl+Enter commits (`ops.setBlockText`) if changed; Esc cancels. The editor keeps its own draft (remote updates never overwrite typing) and must be StrictMode-safe (see `ui/board/InlineText.tsx` for the pattern and the past bug). Call `page.startEditing(cardId)` when the first editor opens and `page.stopEditing()` when the last closes or the panel closes.
- **Block controls** (shown on hover/focus-within at the block's left gutter, real buttons with labels): move up, move down (`ops.moveBlock` with `orderBetween`), delete (immediate, with the Board's Undo toast → `ops.restore`). Between blocks and at the end: a thin "+ Add block" affordance that inserts an empty block there and opens it for editing; an empty block left empty on blur is removed again.
- Empty Page: "This Page is empty." and a primary "+ Add block".
- **Sources** section: header "SOURCES n"; each row: title (600; "Untitled Source" if none), year, authors (`--q-ink-2`), and the identifier as a real link — DOI → `https://doi.org/<doi>` shown as `doi:<doi>`; arXiv URLs shown as `arXiv:<id>`; otherwise the host name. Row actions on hover/focus: "Edit" (inline form) and "Remove from this Card" (detaches: `ops.remove(attachment)`, Undo toast). "+ Add Source" opens an inline form: one field "URL or DOI" (required; validated with `normalizeDoi`/`normalizeUrl`), then Title, Authors, Year (optional). If `page.findSource` finds it on this Branch already, say "Already in Infall: <title>" and attach that one instead of creating a duplicate ("Attach"). Otherwise submit `[ops.createSource, ops.attach]` as one batch.
- **To-dos on this Card**: open To-dos whose `card.id` is this Card (text + owner's first name; the owner can tick theirs), and a one-line "Add a To-do for…" with a Member `<select>` (default: you).
- **Connections**: "→ Title" / "← Title" / "— Title" with the label, each a button that selects that Card on the Board (`boardBridge.focus`).
- **Soft lock (3c)**: when `usePage(id).editor` is set: a banner under the header — avatar, "**<Name> is editing this Page** · since 14:03. You can read it and change the Card's status; the Page opens for editing when they're done." — and Blocks, Sources and the title are read-only (no editors, no controls). Guests / `readOnly`: read-only without the banner; no To-dos section.
- If the Card is removed while its Page is open: replace the body with "This Card was removed." and a "Close" button.

## To-dos screen (6a) — route `/todos`, rail item "To-dos" (not for Guests)
- Header: serif 22/600 "To-dos", mono "13 open · 4 Members", and a segmented filter Open / Done / All (`role="tablist"` not needed — use a radio group; default Open).
- One column per Member (Admins and Members, you first, then by name), min 280px, horizontal scroll if they do not fit. Column head: avatar, name, role ("Member (you)", "Admin"), "n open". Items: a checkbox-like button (a real `<input type="checkbox">` styled; enabled only in your own column — others' have `disabled` and `title="Only <First name> can tick this"`), the text (done: 55% opacity + line-through), and under it chips: the Card pointer and "Assigned by <First name> · <date>" when `created_by !== owner`.
- **Card chip**: if `card.id` is a live Card on the open Branch → button "Card: <current title>" that goes to the Board and focuses it; else if `card.branch` is another existing Branch → link "⑂ <branch name> · Card: <stored title> ↗" to that Branch's route (focus the Card after it opens if cheap; otherwise just open the Branch); else a dashed chip "Card removed · <stored title>" with `title="The To-do is kept; the Card it pointed to was removed."`
- Add: at the foot of each column an input "Add a To-do…" (your column) / "Assign to <First name>…" (others); Enter adds. Own or self-created items show "Edit" and "Delete" on hover/focus (edit in place; delete immediately with an Undo that re-adds it).
- From the Board: the inspector and the Page's To-dos section create To-dos with `card: { id, title, branch: <open Branch id> }`.
- Empty: "No To-dos yet. Add one below." Loading after 150 ms: "Loading To-dos…".


---

# M5 — Suggestions and AI access

Design source: `design/Qoop Board.dc.html` screen **5a Suggestions inbox** (match it; the list markup starts a little above the `<span>{{ s.target }}</span>` line, sample data in the script block), `design/QBoardCanvas.dc.html` (how a suggested Connection is drawn: dashed, accent, label "Suggested · …"), `design/QRail.dc.html` (rail item with count), `design/Qoop Access.dc.html` (settings look). Data layer: [CONTRACT.md](../lib/CONTRACT.md) "M5". Vocabulary: Suggestion, Source, Connection, Member; "AI" is fine. Never "recommendation", "proposal", "bot", "assistant" as a noun for the feature, "API key" for the access token (say "access token").
Not in M5 (do not show): the AI sidebar, Conversations, Pin, model pickers, OpenRouter keys.

## Suggestions panel (5a) — inside the Board area
- Rail item "Suggestions" with the pending count in a mono badge (accent when > 0; not for Guests). Clicking it goes to the Board if needed and calls `suggestionsPanel.toggle()`; `aria-pressed` while open.
- When `useSuggestionsPanel().open`: a 420px panel docked to the **left** edge of the Board area (the Board stays live to its right; shift the Board's left-side overlays — toolbar, counts — beside it). Header: serif 17/600 "Suggestions", mono "n pending", and ✕. Under it one quiet line: "Proposed by AI through a Member's access token. Nothing is added until someone accepts."
- One block per Suggestion: kind chip ("SOURCE" solid border / "CONNECTION" dashed border, mono caps), `target`, then `title` (600), `meta` (mono 11 `--q-ink-2`), "**Why:** <reason>", and a mono 10.5 `--q-ink-3` line "via <Member first name>'s AI · <model if any> · <date>". Pending ones have "Accept" (primary, 26px) and "Reject".
- **Connection preview**: hovering or focusing a pending Connection Suggestion (or its buttons) calls `suggestionsPanel.preview({ id, from, to, kind, label })` and clears it on leave/blur; the block shows "previewing on Board ↗" and an accent-soft background. The Board draws that Connection dashed in `--q-accent` with the label chip "Suggested · <label or kind>" (dashed accent border), non-interactive, and gives the two Cards the accent ring; if either Card is off-screen, pan just enough to show both (no zoom change unless they do not fit). The preview disappears with the panel.
- **Accepting a Connection**: `suggestions.accept(id)` → the block becomes "Accepted by you · just now" at 55% opacity.
- **Accepting a Source**: after success the block shows "✓ Source added to Card: <title>" and offers, checked by default, "Also create a To-do: **Read this**, assigned to <select of Members, default you>" with a button that reads "Create To-do" (checked) or "Done" (unchecked). Creating it calls `todos.add({ owner, text: "Read: <Source title>", card: { id, title, branch } })`. Then it reads "Accepted · To-do “Read this” created for <First name>" or "Accepted by you · just now".
- **Rejecting**: "Rejected by you · just now · Undo" (Undo = `suggestions.reopen`). Decided blocks by others read "Accepted by <First name> · <date>" / "Rejected by …".
- `stale`: no Accept; a line "The Card this was for is no longer on this Branch." and only "Reject". `existingSource`: a line "Already in Infall — accepting attaches the existing Source." Failures: an inline plain sentence in the block (`already_decided` → "Someone else already decided this one." and the list refreshes).
- Empty: serif "No Suggestions", then "When a Member's AI proposes a Source or a Connection, it appears here for the team to review." and a link "Set up AI access" to `/settings/ai`. Loading after 150 ms: "Loading Suggestions…".
- Clicking a Card name in `target`/`title` focuses that Card on the Board (`boardBridge.focus`). Esc with focus in the panel closes it. Not available while previewing History (close it when a preview starts).

## AI access (route `/settings/ai`, account-menu entry "AI access"; not for Guests)
A single centred column (max 720px), settings look as in `Qoop Access`.
- Serif 22/600 "AI access". Intro, two short paragraphs: "Infall doesn't ship a model. Connect the AI you already use — it can read this team's Research Content and propose Sources and Connections as Suggestions. It cannot change anything by itself." / "An access token lets an AI act as you, read-only plus Suggestions. Treat it like a password; anyone holding it can read everything you can."
- **Access tokens**: table (name, created, last used — "never" if unset, "Revoke" with a confirm dialog naming the token). Form: "Name" (placeholder "e.g. Claude Code on my laptop") + "Create access token". On success a panel: the secret in a read-only mono field with "Copy", the line "This is shown once. Store it in your AI app now.", and "Done". Limit reached (10) → plain sentence.
- **Connect Claude Code**: a read-only code block with a Copy button containing exactly `claude mcp add --transport http qoop <toolEndpoint()> --header "Authorization: Bearer <YOUR_TOKEN>"` — when a token was just created, show the real secret in place of `<YOUR_TOKEN>` until "Done" is pressed. Under it: "Other MCP clients: endpoint <toolEndpoint()>, header Authorization: Bearer <token>."
- **What the AI can do**: a short list — "Read Cards, Pages, Sources and Connections on any Branch", "Propose a Source for a Card", "Propose a Connection between two Cards", "Not: change, delete, or accept anything".
- A quiet note: "Text on the Board was written by people and other AIs. A careful AI treats it as content, not as instructions."


---

# M6 — Visuals and the Guest view

Design source: `design/QPage.dc.html` (the "Visual · Bloch sphere" block: header strip, body, controls — match it), `design/Qoop Access.dc.html` screens **10a Guest view**, 11a (login hint), 11c (invite role and Guest rows), `design/QTopBar.dc.html` / `design/QRail.dc.html` with `guest` true. Contracts: `docs/specs/api.md` §13 (the frame protocol), [CONTRACT.md](../lib/CONTRACT.md) "M6". Vocabulary: Visual (a kind of Simulation; never "widget", "demo", "animation", "embed"), Guest (never "viewer", "visitor").
Not in M6: Run blocks, image blocks, sharing a single Page by public link.

## Visual blocks (Page panel)
- "+ Add block" now offers two choices in a small menu: "Text" and "Visual". Choosing Visual opens a starter picker: "Blank", "Bloch sphere", "Function plot" (each a complete, self-contained source kept in `ui/page/visuals/templates`; they must work under the frame's rules: no network, no external scripts, inline `<script>`/`<style>`, `<canvas>` or SVG, colours from the `--q-*` variables so they follow the theme). The block is created with the template's source and title and opens in the editor.
- **Reading**: a framed block (1px `--q-line`, radius 8). Header strip (mono 10.5 caps for the labels): a small orbit glyph, "VISUAL", the title in sans 13/600 (not upper-cased), spacer, "interactive · runs everywhere" in `--q-ink-3`. Body: the sandboxed iframe exactly as api.md §13 says (`sandbox="allow-scripts"`, `src={VISUAL_FRAME_PATH}`, `title="Visual: <title>"`, no border, width 100%), height from the frame's `height` messages clamped to 80–900px (default 240 until the first message; taller content scrolls inside the frame). Send `render` on `ready` with the block's source and the current theme (read the `--q-*` custom properties the templates need from the document — at least ink, ink-2, ink-3, line, line-soft, accent, accent-soft, surface, raised, the five status colours — plus `color-scheme`); reload the frame when the source or the app theme changes. Accept messages only when `event.source` is that iframe's `contentWindow` and `data.qoop === "visual"`.
- An `error` message shows a quiet strip under the body: "This Visual reported an error: <message>" (`--q-st-question` tint, mono 11.5); it never breaks the Page.
- Frames are created lazily: only when the block scrolls near the viewport (IntersectionObserver), so a long Page does not start dozens at once.
- **Editing** (Members, not under soft lock): an "Edit" button in the header strip (and Enter when the block is focused) opens: a "Title" field, a source `<textarea>` (mono 12.5, at least 14 rows, Tab inserts two spaces, no spell-check), a "Run" button that re-renders a live preview frame below the editor from the draft, and "Done" (commits changed title/source in one batch) / "Cancel". ⌘/Ctrl+Enter runs; Esc cancels (confirm nothing — the draft is discarded, as with text blocks). One hint line: "HTML, CSS and JavaScript. Runs in a sandbox: no network, no access to Infall. Use the --q-* colour variables to follow the theme." Soft-lock claim and StrictMode rules as for text blocks. Move up/down/delete controls as for text blocks.
- Guests and read-only: Visuals are fully interactive; no Edit button.
- In the Merge review a Visual Conflict simply shows the two sources as mono text (existing field Conflict UI) — no change needed there.

## Guest view (10a)
A Guest sees: the Board of `main` (read-only, pan/zoom/select), Frames in the rail, search, the Page panel read-only with working Visuals, the theme toggle, sign out. Nothing else.
- Top bar: no Branch switcher (plain "main · read-only"), no Checkpoint/History buttons, no presence list; a badge "Guest — access until 30 Nov" (`--q-st-question` outline) with `title` "Read-only access to the main Branch. It ends automatically."; account menu has only the name, "Guest", and "Sign out".
- Rail: "Board" and the Frames list only; footer sync text reads "Read-only" (and "Reconnecting…" when the socket is down).
- Page panel for Guests: no To-dos section, no editing affordances, header says "Read-only". The inspector shows fields as text, no "Delete Card".
- Any Member-only route (`/todos`, `/branches`, `/b/…`, `/merge`, `/members`, `/settings/ai`) redirects a Guest to `/`.
- When a Guest's access ends while they are looking (any request answers 401): the app returns to the login screen with the line "Your Guest access has ended. Ask the team's Admin if you need more time."
- Accept-invite screen for a Guest invite: "You're invited as a Guest — <email>" and "Read-only access to the team's Board until <date>." above the Name/Password fields.
- Login screen: add under the form "Got an invite? Open the link you were sent." (There is no password-less Guest link; Guests set a password like everyone.)
- Members screen (Admin): Guests listed after Members with a "Guest · until <date>" role chip (outlined `--q-st-question`); expired ones read "Guest · ended <date>" in `--q-ink-3`. The invite form already has the role choice and date; under the role choice show the one-line note "Read-only Board and Pages on main. No editing, To-dos, AI or History." for Guest and "Full access: edit, Branch, Merge, To-dos and their own AI." for Member.


---

# M7 — the AI sidebar, Pin, and AI settings

Design source: `design/Qoop Board.dc.html` screens **4a AI sidebar conversation** and **4b AI sidebar empty** (match them: 376px column, header, privacy line, messages, scope chip, composer), `design/QPage.dc.html` (the "AI-GENERATED" pinned block), `design/Qoop Access.dc.html` screen 11b (the AI part of Member settings), `design/QTopBar.dc.html` with `ai` true (the top-bar button). Contracts: [CONTRACT.md](../lib/CONTRACT.md) "M7", `docs/specs/desktop.md`. Vocabulary: Conversation (never "chat", "thread", "session"), Pin, AI; "Claude Code" and "OpenRouter" are product names.

## Top bar and layout
- A top-bar button "AI" (spark icon, `aria-pressed`) toggles `aiPanel` (`ui/bridge`); not for Guests. When open, the shell grid gains a 376px right column for the sidebar on **every** screen (Board, To-dos, Branches…); the work area shrinks. Below 1100px window width the sidebar overlays the work area instead of shrinking it.
- The Board publishes what is selected through `boardFocus.set(...)` (one selected Card, or the Card whose Page is open; otherwise null).

## Sidebar (4a)
- Header: "AI", then what answers — "Claude Code" (+ version in `title`) or the OpenRouter model name; "+" (New Conversation); a Conversations menu (list by title and date, newest first; each with a delete button; confirm delete inline); "⇥" collapses the sidebar.
- Under the header, always: "**Private** — only you can see this Conversation. Pin copies an answer into a Page."
- Messages: the Member's messages as right-aligned bubbles (`--q-raised`), with a small chip of what they were looking at when it differs from the previous message; answers as plain flowing Markdown (reuse the Page's Markdown/KaTeX renderer — import it from `ui/page`, do not copy it; links open in a new tab; no raw HTML). While streaming: a quiet caret and a "Stop" button; used tools as a mono 10.5 line "read: list_cards, get_card" / "proposed a Suggestion" (when a `suggest_*` tool ran; link "Open Suggestions" → `suggestionsPanel.open()` after going to the Board). `error`: the sentence in `--q-st-question` and "Try again" (re-sends the same user message). `stopped`: "Stopped." in `--q-ink-3`.
- Under each finished answer: "Pin to Page" and "Copy". Pin targets the scoped Card: with a Card in scope the button reads "Pin to Page · <Card title>" and calls `ai.pin`; afterwards it shows "✓ Pinned to Page · <Card title>" (a button that opens that Page). With no Card in scope it is disabled with `title="Select a Card to pin this to its Page"`. An answer may be pinned to several Cards.
- Composer (bottom): the scope chip — "Card: <title> ✕" with the note "follows your selection" (✕ switches to the Board scope until the selection changes), or "Board: <branch>"; a textarea "Ask about Card: <title>…" / "Ask about Board: <branch>…"; hint "⏎ send · ⇧⏎ new line". Disabled while an answer streams (except Stop). The draft survives closing and reopening the sidebar (memory only).
- Empty Conversation: three quiet starter prompts as buttons, depending on scope ("What is missing from this Page?", "Which Sources should this Card cite?", "What should connect to this Card?" / "Summarise the state of this Board", "Which Cards look related but are not connected?", "Where are the open questions?").

## No AI set up (4b)
When `useAi().setup.provider === 'none'` the body shows, by `reason`:
- `desktop_no_claude`: serif "AI isn't set up on this computer", then "This sidebar runs on your own Claude subscription through Claude Code. Install Claude Code, sign in to it once in a terminal, then press Check again." + button "Check again" (`ai.refresh()`), and the line "Or add an OpenRouter key in AI access." (link).
- `browser_no_key` / `no_model`: serif "AI isn't set up for you", then "Infall doesn't ship a model. In the desktop app this sidebar runs on your own Claude subscription. In the browser, add an OpenRouter key in AI access." + link "Open AI access"; for `no_model`: "Choose a model in AI access."
- `server_off`: "…In the browser it needs an OpenRouter key, which this server is not set up to store. Ask your Admin, or use the desktop app."
- Always the line "Conversations are private. Other Members only see answers you Pin."
- The composer is shown disabled with "Set up AI to ask about …".

## Pinned blocks (Page)
A Block with `ai` set renders as in `QPage`: a bordered block with a header strip — chip "AI-GENERATED" (mono caps, dashed border), the model, spacer, "Pinned by <Name> · <date>"; the Markdown body in a `<blockquote>`-like inset; footer line: "Not reviewed by a Member." with a button "Mark reviewed" (any Member; `ops.markReviewed(block, me.id)`), or "Reviewed by <Name>." once set. It can be moved and deleted like any block; editing its text is allowed and keeps the AI marking (the header then adds "· edited"? — no: keep it simple, no extra state). Guests see it read-only.

## AI settings (the `/settings/ai` screen gains a section, above "Access tokens")
- "**AI sidebar**" card. First line, by environment: in the desktop app "This app runs the sidebar on your own Claude subscription through Claude Code — nothing to set here." + status line "Claude Code <version> found" / "Claude Code not found on this computer" (+ "Check again"); in a browser "In the desktop app the sidebar runs on your own Claude subscription. In the browser it needs an OpenRouter key."
- "OpenRouter (optional)": if `enabled` is false: "This server is not set up to store keys. Ask your Admin." Otherwise: the key as "••••<last4> · added <date>" with "Replace" and "Remove" (confirm), or a password-type field "OpenRouter key" + "Add key"; then "Model": a `<select>` filled from `ai.models()` (with a text filter above it when the list is long; shows the current id even if the list fails to load) — changing it calls `ai.setModel`.
- Small print: "Your key is stored encrypted on <host> and is never shown again. The server sends your question, and what the AI reads through Infall's tools, to OpenRouter. Conversations are kept only on this device."
- The key field is never pre-filled, never logged, cleared after submit; failures in plain words.


# M8 — Run blocks

Design source: `design/QRunBlock.dc.html` (match its structure, spacing and type; states `desktop`, `browser`), and the Run inside `design/QPage.dc.html`. Sync layer: CONTRACT.md "M8 — Runs and the Runner". Glossary: Run, Runner, Simulation — never "notebook", "cell", "job", "kernel".

## Run blocks (Page panel)
- "+ Add block" menu gains "Run" (after "Visual"). It creates a Run with title `experiment.py` and a three-line starter (a comment saying what a Run is, and `print("hello from Infall")`) and opens it in the editor.
- **Reading** — a framed block (1px `--q-line`, radius 6, `--q-surface`), three parts:
  1. **Header strip**: play-outline glyph, "RUN · <LANGUAGE>" (mono 10 caps, `--q-ink-2`, the language `--q-ink-3`; M19b), the title in mono 12, then the environment the Run asks for as a quiet mono chip (Python and Q#; M19), spacer, then the action. (Since M19b what executed the last result is said under the output, not here.)
     - Runner available: primary button "Run" (accent fill, small play glyph; `title` "Run on this computer"). While this block is `live`: `approval` → the button reads "Waiting for you…" (disabled) and a line under the header says "Check the Infall window that just opened: it shows this code and asks before running it."; `running` → a "Stop" button and elapsed time in mono ("0:42", ticking each second); `saving` → "Recording…". While another block is live: the button is disabled with `title` "Another Run is in progress".
     - No Python chosen yet (`available` without `python`): button "Set up the Runner…" → `runs.configure()`.
     - Browser: "Desktop app only" in `--q-ink-3` and a disabled outline button; plus the sunken info strip from the design: "Code can only run in the Infall desktop app. You're in the browser — the captured output from the last Run is shown below." (when there is no result: "… — this Run has not been executed yet."). `old_app`: same strip with "This version of the desktop app cannot run code. Update the app."
     - Guest, or a moment in History previewed: no button, no strip.
  2. **Code**: sunken (`--q-sunken`) mono 12/1.62 with a right-aligned line-number gutter (34px, `--q-ink-3`, not selectable), horizontal scroll for long lines, no wrapping, no syntax colours. Longer than 24 lines: collapsed to the first 24 with "Show all N lines" / "Show less".
  3. **Output** (top border `--q-line-soft`, padding 10/12): label "OUTPUT" (mono 10 caps `--q-ink-3`) and to its right "live" while running, else nothing. Then, in order: figures (each `<img>` from `data:image/png;base64,…`, `max-width: 100%`, alt "Figure N of Run <title>", white background plate with 1px `--q-line-soft` since plots are drawn for white); the text output in a `<pre>` (mono 11.5, wraps, max-height 320px with its own scroll, kept scrolled to the end while live unless the Member scrolled up); if `output_truncated`: "Part of the output was left out." Then the record line (sans 12 `--q-ink-2`): avatar initials, "Last run by <Name>, <date>, <time>" + " · current code" or " · code changed since" (`useRunStale`; the latter in `--q-st-question`), spacer, mono 11 `--q-ink-3`: duration ("3.0 s", "6 min 41 s") and, when not 0, "exit <code>" or "stopped" (exit ≠ 0 in `--q-st-dead` or the app's error colour, with the words — never colour alone).
     - No result: "Not executed yet." in `--q-ink-3`. `broken`: "This result cannot be shown."
     - While live the live output replaces the stored one; the stored figures stay hidden until the new result is recorded.
- **Outcome strip** (under the header, for `runs.last` on this block until dismissed): `declined` → nothing; `failed` → the sentence, with "Runner settings…" when it is about Python; `unsaved` → "The output was captured but could not be recorded: <sentence>" with "Record again" (`runs.saveAgain()`) and "Discard" (`runs.dismiss()`); `recorded` → nothing (the new result is its own confirmation; announce "Run finished" politely to screen readers).
- **Editing** (Members, not under soft lock): "Edit" in the header strip (Enter on the focused block) opens a "Name" field and the code `<textarea>` (mono 12.5, ≥ 14 rows, Tab inserts four spaces, Shift+Tab removes them, no spell-check, no autocapitalise), "Done" / "Cancel", Esc cancels — same draft, soft-lock and StrictMode rules as Visual blocks. Hint line: "Python. Runs on the computer of whoever presses Run, in the desktop app, after they have seen the code. Figures drawn with matplotlib are captured." Editing does not clear the result: the record line then says "code changed since". (M19b: the hint names the language; the editor also has Language and, for Python and Q#, the environment — see below.) Move up/down/delete as for other blocks; a block that is live cannot be edited or deleted from this window (controls disabled).
- A small "⋯" menu in the header (Members in the desktop app): "Runner settings…" (`runs.configure()`), and when there is a result "Clear output" (`ops.setRunResult(block, null)`, confirm).
- Page meta line counts Runs ("1 Visual · 1 Run") where it already counts Visuals.
- Merge review: nothing new in the UI — the sync layer gives readable lines for `result` and `canEdit: false`.
- Accessibility: the block is a `group` labelled "Run <title>"; live output region `aria-live="off"` (too chatty) with state changes ("Run started", "Run finished", "Run stopped", "Run failed: …") announced through one polite status element; all buttons reachable in order header → code → output.

## M19 Part 2 and M19b — languages and environments on the Run block

Sync layer: CONTRACT.md "M19 Part 2 and M19b". Desktop: desktop.md "Environments and Toolchains — as built". Code: `ui/page/runs/` (`RunBlock.tsx`, `RunEditor.tsx`, `format.ts` `runtimeLine` / `editorHint`, `runs.css`).

- **Label**: "Run · Python", "Run · Q#", "Run · Julia", "Run · R", "Run · JavaScript", "Run · Shell"; another id by the name this device's Runner gives it, else the id. The environment a Python or Q# Run asks for follows the title as a chip (hidden in a narrow frame).
- **Editor** (Members): under Name, a row with **Language** (`<select>`: Python, Q#, Julia, R, JavaScript, Shell, Other…), **Language id** when Other… (checked on blur and on Done: "A language id is 1–24 characters: a lowercase letter, then lowercase letters, digits, - or _."), and for Python and Q# **Environment this Run asks for** (free text, the device's `environments` offered through a `datalist`, placeholder "The default environment", hint "A name only: each computer decides which of its environments it means, and asks once when it does not know.", error "An environment name is one line of at most 60 characters, without invisible characters."). Changing to a language that takes no environment drops the one asked for. The hint under the code names the language. Language and environment go out with the name and code in one batch: one step of Undo. No syntax colouring (the block never had any).
- **What this device can execute** (desktop, not live): Python as before. Another language: an app without `start` or `languages` → info strip "Update Infall on this computer to run Julia code.", Run held back (`aria-disabled`, same `title`), nothing else to press. Not listed in `status().languages` → "Julia is not set up in Runner settings on this computer." with **Open Runner settings** (`runs.configure('julia')`). In a browser and for Guests: nothing about languages; the captured output reads as before.
- **Waiting**: while the Runner window asks which environment a name means (`live.choosing`), the line under the header reads "Waiting for a choice in the Runner window…" (announced politely); then the approval line as before. A `failed` outcome with `no_environment` / `no_toolchain` / `no_python` offers **Runner settings…** beside the app's sentence.
- **The line under the output** (above the record line, mono 11 `--q-ink-3`, the lead `--q-ink-2`): "Python 3.12.3 · numpy 2.1.0, scipy 1.14.1 +5", "Python 3.13.1 (analysis) · …" when the Run asked for an environment, "Q# · qdk 1.34.0", "Julia 1.11.2" (the version found in what the Toolchain said; the whole text in the tooltip with the machine). "+N" is a small outlined button (`aria-expanded`) that opens a sunken grid listing every package (up to 32).
- **Record line**: " · current code" as before; otherwise, in `--q-st-question`: " · code changed since" (the code), " · ran as Python" (the result was made in another language), " · ran in “analysis”" / " · ran in the default environment" (made in another environment than the Run now asks for).
- **Settings → Runs** (an app from M19b): **Languages** (each name and its version) and **Environments** (names) under Python and Folder, "None set up yet" / "Only the default Python" when empty; the button reads **Open Runner settings**.

## M9 — the Runner monitor

A control in the top bar that exists only while `useRuns().live` is non-null (a Run is waiting for approval, executing or being recorded on this computer). It is how the Member sees what their computer is doing while they are on another Card or on the Board.

- **Closed**: a compact button — a quiet pulsing dot (still under reduced motion), the Run's title (cut with an ellipsis), the running time in tabular figures (`0:42`, `1:02:03`). When progress is known, a thin progress line along its bottom edge. While `approval`: "Waiting for you…", no time.
- **Open** (a popover under it; Esc and a click outside close it; focus returns to the button; it is a dialog-like region with a label, not a menu of commands):
  - the Run's title and the Card it is on — a button that opens that Card's Page and scrolls to the Run;
  - **Now**: `step` when the code reports one; otherwise "Running" / "Waiting for you in the Runner's window" / "Recording the result…";
  - **Progress** (only when reported): a bar, "45 of 100", and "about 3 min left" from `eta_ms` (rounded honestly: seconds under a minute, minutes under an hour, then hours and minutes; "estimating…" while progress is known but `eta_ms` is not);
  - **Processor**: "182 % · 1.8 of 10 cores" with a meter scaled to all cores;
  - **Memory**: "1.2 GB of 24 GB" with a meter, and "peak 1.4 GB";
  - **Graphics**: "76 % · whole computer" (+ name when given); when absent: "Not reported on this computer";
  - **Running**: the time; **Left**: the estimate, or "No estimate — the code reports no progress" with one quiet line showing `qoop.progress(done, total)`;
  - **Stop** (the same action as the Run block's Stop).
  - No `stats` yet: the three usage rows say "Measuring…"; after 10 s of running without one (an M8 app, or a first sample that is late) they say "No numbers yet" in the same rows, so nothing moves; a sample that arrives later fills them.
- Meters are `role="meter"` with a text value; numbers never rely on colour alone; a meter turns to the warning colour at ≥ 90 % of memory. Values update about once a second and must not move the layout (tabular figures, fixed row heights). Not announced to screen readers on every tick.
- Not shown to Guests, in the browser, or when nothing runs. One Run at a time, so one monitor.


---

# Top bar, two rows (design update, Nov 2026)

`design/QTopBar.dc.html`. Replaces the single 44px bar.
- **Row 1, 30px — the window's title bar** (`q-titlebar`, background `--q-chrome` mixed 68% with `--q-sunken`): 224px brand cell (Infall mark 18px: a black hole in its ring, the disc crossing in front + "Infall"), the search field centred (22px high, max 380px), then presence ("On <branch>" + 20px avatars), a divider, the theme toggle and the account button (18px avatar + name). In the macOS desktop app the window has no title bar of its own (Tauri `TitleBarStyle::Overlay`): the traffic lights sit at the left of this row, the brand cell leaves 75px for them, and the row is a `data-tauri-drag-region="deep"` (empty parts move the window; a double click zooms).
- **Row 2, 36px — the Branch toolbar** (`q-toolbar`, `--q-chrome`): Branch switcher, divider, Checkpoint, History; on the right the Runner monitor (while a Run is in flight), a divider and AI. Guests: the plain "main · read-only" label and the Guest badge on the right. Toolbar buttons are 26px with a transparent border until hovered or pressed.
- Not taken from the mock-up: Undo/Redo in the top bar (since M15 they are on the Board's toolbar and in the Page header: see "M15 — Undo" below), "All changes saved" (the rail already says "Synced"; never "saved"), the team name next to the logo (no such data), and the Windows menu bar + caption buttons (Windows keeps its native title bar).


---

# M15b — the Branch Graph

Spec: [docs/specs/branch-graph.md](../../../docs/specs/branch-graph.md) (binding). Data layer: [CONTRACT.md](../lib/CONTRACT.md) "M15b". Code: `ui/branches/` (`BranchGraph.tsx` the screen, `model.ts` its pure arithmetic, `GraphLines.tsx` the drawing, `Rows.tsx` rows and labels, `Detail.tsx`, `NewBranchField.tsx`, `branches.css`); `ui/shell/Branches.tsx` only mounts it. Vocabulary: Branch Graph, Branch, Activity, Checkpoint, Merge, Restore, Change. Never "tree", "timeline", "commit", "node". The look below is plain on purpose: colours, line shapes and spacing are M17's design pass.

## Layout (`/branches`)
- **Header**: serif 22/600 "Branches" + mono count "5 Branches"; on the right the **name field**: label "New Branch", a mono input (placeholder "e.g. decoder-rewrite"), the primary button "Create Branch and switch to it", and under the input the line "Starts <where>" in `startLabel`'s words ("Starts from now on main", "Starts from Checkpoint before-review on main", "Starts from Ana's work at 13:50 on exp-A"), `aria-live="polite"`. Errors under it: "Give the Branch a name.", "Use 60 characters or fewer.", "A Branch with that name already exists.", else the plain sentence of `describeError`. Enter starts the Branch and opens it.
- **Body**: the graph (fluid, `--q-canvas`, scrolls inside its own box in both directions) and the **detail** column (`clamp(260px, 32%, 340px)`, `--q-surface`, left border). Below a container width of 700px the detail moves under the graph (44% of the height); below 560px the name field stacks. Container queries, so they follow the interface scale (`zoom`) and the AI sidebar's column, like `data-room`.
- The text column never gets narrower than 300px; below that the graph scrolls sideways inside its box. The page never scrolls sideways.

## Rows (fixed height 28px × text size; only the rows in view, plus 8 each way, are in the document)
- **A dot's row** (`role="option"` of the `role="listbox"` "Branch Graph"): in the text column, the author's first name (`--q-ink-2`, 6.5em), the time (`formatWhen`, mono 11 `--q-ink-3`, tabular), the first line of what was done ("↺ " before a Restore's), "+N" (mono 11 `--q-ink-3`) when there are more, and a chip "◆ <name>" (mono 11, 1px `--q-line`, radius 3) for each Checkpoint on the dot. Until the words arrive, a 7px `--q-line-soft` bar in place of the line; the row never changes height. Hover `--q-hover` at 55%; selected `--q-accent-soft` (+ a 3px accent bar at the left while the graph has keyboard focus).
- **The start row** (the last): "Before the first Change" in `--q-ink-3`, a hollow dot at main's column, main's Checkpoints at seq 0 as chips.
- **A label row** above the newest dot of each Branch (its fork point when it has no Changes; several stack left to right by column): a 10px swatch in the line's colour, the name (mono 12.5/600), the tag "OPEN" on the Branch the Board has open, the meta "default Branch" or "from <parent> · <who started it> · <when>" (`--q-ink-3`, shrinks first), then 22px buttons "Merge into <parent>…", "Update from <parent>…" (as `mergeOptions` allows; `data-tour="merge-into:<name>"` on the first) and "Open".

## The drawing (one SVG over the lines area of the rows in view, `aria-hidden`)
- Columns 18px wide, 10px padding each side; main in column 0. Line colours are the tokens `--q-lane-0` (main, neutral) … `--q-lane-6`, one per Branch in the order they were started, in both themes. Colour is never the only cue: the label and the detail name the Branch.
- **Line**: 2px, from where the Branch leaves its parent up to its newest dot. **Fork**: from the parent's dot sideways, a quarter turn up into the Branch's column; to a fork point drawn as a mark of its own (a Branch without Changes: hollow circle; a ◆ at its start) the line just runs sideways to it. **Merge**: 1.6px in the colour of the Branch merged from: when the Branch's last dot was merged into its parent, its line goes on up its own column and turns into the parent's Merge dot ("ends in the parent"); otherwise a curve straight from the dot holding the merged moment to the Merge dot. No line for a Restore.
- **Dots**: filled circle r 4 with a 1.5px `--q-canvas` halo; a Merge adds a ring r 6.5; a Restore and the start are hollow; a dot carrying a Checkpoint is a ◆ (r 5.5), clickable on its own (it chooses the Checkpoint's words). Selected: a 2px `--q-accent` ring r 8.

## Detail (the selected dot)
- Nothing selected: "Select a dot to see what was done there, or to start a Branch from it." and the keys: ↑ ↓ rows · ← → neighbouring line · Enter actions · N new Branch · Esc back.
- A dot: swatch + Branch name (+ tag "MERGE" / "RESTORE"); avatar, full name, time span (`formatSpan`); mono "N Changes in this Activity"; all its lines as a "· …" list ("Working out what was done…" until they arrive); for a Merge "Brought in <Branch> as it was at <time>." with a quiet button "Show that moment"; its Checkpoints as toggle buttons "◆ <name>" (`aria-pressed`: the start is that Checkpoint) with "named by <who>, <when>"; then the actions **New Branch from here** (primary), **Preview the Board**, **Add Checkpoint here**, **Show every Change**.
- A fork point: "The start of <Branch>", "No Changes yet. Started from <parent> by <who>, <when>."; the start row: "The start of main", "The Board before the first Change of the Workspace." Both without Show every Change.
- **Add Checkpoint here**: a field "Checkpoint name" (placeholder "e.g. Before decoder rewrite"), "Add Checkpoint" / "Cancel"; errors "Give the Checkpoint a name.", "This Branch already has a Checkpoint with that name.". Done or Esc returns focus to the button.
- **Show every Change**: "Every Change" + mono "N Changes" (= the Activity's count), then one line per Change: time, first name, the Change in plain words; 200 at a time with "Show N more"; "Loading the Changes…", or "The Changes could not be loaded." + "Try again".
- **Preview the Board**: opens that Branch with the History panel at that moment (`ui/history/fromGraph.ts`); the History header then has "Back to Branches". Leaving the preview ("Back to now", scrubbing to now, closing History, "Back to Branches") returns to the graph with the same dot selected; a Restore made from the preview stays on the Board with its Undo.

## Keyboard and access
- The graph is one tab stop (`role="listbox"`, `aria-activedescendant`); the labels' buttons and the detail follow it. ↑/↓ rows (the first press selects the newest dot of the open Branch), ←/→ the nearest dot on the neighbouring line (fork points included), Home/End, PageUp/PageDown, Enter moves focus to the actions, N to the name field, Esc clears the selection. In the name field Esc returns to the graph; in the detail Esc returns to the graph too. Clicking dots while the name field has focus keeps the cursor there, so Enter starts the Branch.
- Every dot's spoken name: "<Branch>, <full name>, <time>, <first line or 'loading'>, Checkpoint <name>"; `aria-posinset` / `aria-setsize` give its place among all rows. A fork point: "<Branch>, the start, no Changes yet".
- Nothing moves: no animated lines, no smooth scrolling (reduced motion or not).
- Loading: "Loading Branches…" after 150 ms. Failure: "The Branch Graph could not be loaded." + "Try again". Guests never reach the screen.


---

# M15 — Undo

Spec: [docs/specs/undo.md](../../../docs/specs/undo.md) (binding). Data layer: [CONTRACT.md](../lib/CONTRACT.md) "M15 — Undo" (`useUndo`, `undo.*`, the notes). Code: `ui/board/UndoButtons.tsx` (the buttons), `ui/board/undoActions.ts` (the keys, where Undo works, the note), `ui/shell/UndoKeys.tsx` (the keys, and `window.__infallUndo` for the desktop app's Edit menu). Vocabulary: Undo, Redo, step, gesture, Change. Never "revert", "rollback" or "history" for this.

## The Undo and Redo buttons (`UndoButtons`)
- A pair of 26px icon buttons, 2px apart: a curved arrow back, and the same arrow mirrored. One component in two places: the Board's toolbar, right of "+ Card" / "+ Frame" in a toolbar of its own (`aria-label` "Undo and Redo", `data-tour="undo"`, the toolbar's button look), and the Page header, between the sync text and Page tools (`qp-head__btn`, `align="end"`). Neither in read-only mode: not for Guests, not while History previews a moment.
- Each button is named by its step: `aria-label` "Undo Move 3 Cards" / "Redo Delete Card Axions", or "Nothing to undo" / "Nothing to redo". With nothing to do it is `aria-disabled` (not `disabled`, so focus stays on it when the last step is undone), `--q-ink-3`, `cursor: not-allowed`, and a click does nothing. `aria-keyshortcuts` gives the keys.
- **Tooltip** (`q-undo__tip`, not `title`): the step's name, then the keys in a `<kbd>` (mono 11, `--q-ink-3`): "⌘Z" / "⇧⌘Z" on a Mac, "Ctrl+Z" / "Ctrl+Y" elsewhere. `--q-raised`, 1px `--q-line`, `--q-shadow`, sans 12/500, at most min(320px, 70vw) wide so that a long Card title wraps. Under the button, lined up with its left edge (Board) or its right edge (Page header). Shown after 250 ms of hover, at once on keyboard focus; opacity only, and no transition under reduced motion. `aria-hidden`: the label already says it.

## The note after an Undo or Redo
- One line in the Board's toast region (bottom centre, `role="status"`, polite) for 5 s, one at a time: a new note replaces the last. The words are the lib's (`UndoResult.note`), shown as they are: "Undid Move 3 Cards.", "Undid Move 3 Cards. 1 left as it is — Ana changed it since.", "Not undone — Ana changed this since.", "Nothing to undo. To go further back, use History.", "Redid …", "Could not undo … — the Board was updated meanwhile. Try again." No button on it.
- A delete's toast ("Deleted 2 Cards." with "Undo" for 6 s) is the same step: its "Undo" undoes that step while it is still the newest one, and the note says what was done; once another step came after it, it brings the things back as a step of its own. An Undo or Redo by key or button takes the delete's toast away.

## Keys
- Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z, and Ctrl+Y off a Mac, handled once in the shell, wherever the Board of the open Branch is shown and editable. In a field being edited and in a modal dialog the key is the field's (its own text undo); anywhere else it does nothing. Never with Alt, never with Cmd and Ctrl together; the Board scale keys (Shift + "+", "−", 0) are not these.


---

# M18 — From alone to a team

Spec: [docs/specs/team-move.md](../../../docs/specs/team-move.md) (binding). Data layer: [CONTRACT.md](../lib/CONTRACT.md) "M18". Vocabulary: Workspace file, Team server, Local Workspace, Member, Admin, Guest, Comment, For you. Never "backup", "archive", "note", "message", "chat", "thread" in a button (the section is "Comments").

## Empty Team server (Admin) — `ui/shell/FirstScreen.tsx`
- In place of the Board while `useWorkspace().empty` (Team only) for an Admin; Members see the ordinary empty Board. Serif "This Team server is empty", one line, then **Bring in <name> from this computer (<size>)** (primary; only when `desktopMove()` reports a pending move), **Bring in a Workspace file…** (primary when there is no move; opens a hidden, labelled file input "Workspace file", `.infall`), **Start empty**.
- Sending: "Bringing in <file>…", a `role="progressbar"` (aria-valuetext "45 %" / "Sent; the server is reading the file"), "1.2 MB of 3.4 MB" in mono, **Stop**. A refusal: the server's sentence + "Choose another file, or try again." (`role="alert"`), the choice again.
- Done: serif "The Workspace is in" (focused), "Your earlier work as <you_were> is now yours.", and when the file brought unclaimed names, a box "Names that came with the file" — "<name> — not signed in yet" with **Invite** (a link to `/members?claim=<id>`) — then **Open the Board**. The screen stays up after the import (`useFirstScreen.holding`) until that press or Start empty.
- The desktop move is one press: `moveFile()` → the upload → `moveDone({ ok })` (ok false on any failure, so the app keeps the move).

## A moved Local Workspace — `ui/shell/MovedBar.tsx`
- A quiet bar over the work area on every screen (`q-moved`, `--q-surface`, a lock glyph): "Moved to <host>. This copy is read-only." ("Moved to a Team server. …" without `movedTo`). In the desktop app, **Open on the server** with the visible hint (its description) "Goes back to the start screen, where this Workspace’s row has Open on the server." (the page cannot open the server itself). The server's sentence of a refused write shows once in the bar's status line.
- Read-only everywhere, the way a Guest's view is (the Board's `readOnly`): no + Card / + Frame / Import BibTeX / Undo / Redo, no editing on the Board, in the inspector or the Page, no Page To-dos, no Comment writing, no Checkpoint button, no "New Branch…" in the switcher, no name field / Merge buttons / New Branch from here / Add Checkpoint here on the Branch Graph, no Restore in History (History still reads), no Suggestions (rail item and panel), To-dos without ticking, adding, editing or deleting, AI answers not pinnable ("This copy is read-only…"), no Change name in Settings, no Merge route, no Tutorial. The rail footer says "Read-only".

## Settings → Workspace (Team, Admin)
- A card "Workspace file": what it holds (names only; no emails, passwords, invites, access tokens or AI keys), **Export Workspace file…** ("Exporting…"); then "Exported “<name>”." (desktop app, `saveBinaryFile`) or "Downloaded “<name>”." (browser), nothing when cancelled; a failure "The Workspace file could not be exported. <the server's sentence or plain words>".
- The Board's PNG export goes through `saveBinaryFile` when the app has it ("Exported “…”."), and the dialog's "saves text files only" note is shown only in an app without it.

## Members — unclaimed names
- "<name> — not signed in yet" (no email), **Invite** beside **Remove**. Invite (or `?claim=<id>`) turns the form into "Invite <name>" with the line "Whoever accepts takes over the name <name> — their Changes, Checkpoints, To-dos and Comments." and "Invite someone new instead"; focus goes to Email; the button reads "Create invite for <name>"; the invite is sent with `claims`. Below a wide room the form stacks under the table.

## Comments — `ui/page/comments/`
- A section in the Page under Sources and To-dos (and under "This Card was removed." for a removed Card, with "On a Card that was removed. The thread is kept."). Head: "COMMENTS · n" (" · resolved"), **Resolve** / **Reopen** on the right (any Member, when there are Comments). In a Local Workspace: "Notes to yourself: …".
- Each Comment: avatar, author (600), time (mono, full date in `title`), "· edited"; the text with paragraphs and line breaks as written and the Page's inline Markdown and `$math$` (`renderInline`), mentions in accent 600. **Edit** (own) and **Delete** (own; an Admin any), Delete asking inline "Delete this Comment? It cannot be brought back." **Delete** / **Keep it**. Editing reuses the write box: **Done** / **Cancel**, ⌘Enter / Esc; focus returns to Edit.
- Resolved: collapsed to "This thread is resolved." + "Show all n Comments" / "Hide the Comments"; no write box ("Reopen the thread to add a Comment.").
- Write box: label "Start the thread" (placeholder "A question or a remark about this Card…") or "Add a Comment"; hint "@ to mention a Member · Markdown and $math$ · ⌘Enter to add"; **Add Comment** ("Adding…"). From 9 000 characters a counter "9 412 / 10 000"; past 10 000 "… — 3 too many" in the danger colour and the button refuses. A failure: "The Comment could not be added. <the server's sentence>" with the text kept.
- `@` completion (`MentionField`): the textarea is a combobox; a list "Members to mention" (avatar + name, ≤ 6) opens under it while a mention is typed; ↑ ↓ move (wrapping), Enter or Tab picks ("@Name "), Esc closes the list only (not the Page). Members and Admins only (never Guests); in a Local Workspace only yourself.
- From For you: the Page opens at that Comment — a resolved thread opens, the Comment scrolls to the middle (smoothly only when motion is allowed), takes focus and is tinted `--q-accent-soft` for 2.4 s. "That Comment was deleted." when it is gone.
- Guests: no section at all. A moved copy: the thread reads, nothing else.

## The badge on a Card
- Full level: in the footer row after "¶ n" / "n Sources": a speech-mark glyph and the count, "✓" after it when resolved (`--q-ink-3`); compact level: the same, right-aligned on the status row. Never on a tile. Screen readers hear "3 Comments" / "1 Comment, resolved". From `useCommentCount` — one store read per Card, no request, nothing per frame.

## For you — `ui/todos/ForYou.tsx`, route `/for-you`
- Rail item "For you" (an "@" glyph) right after To-dos, badge = unseen (accent when > 0), `aria-label` "For you, n unseen". Not for Guests (the route goes to the Board).
- The To-dos screen pattern: the header starts with two tabs (links) "To-dos" | "For you n", then serif "For you", mono "n unseen · m mentions", **Mark all as seen**. One row per mention, newest first: avatar, "**Ana** mentioned you on Card <title>" (or "a Card that was removed"), time; unseen rows have a stronger border and "● NEW" (word and shape, not colour alone). A row is a button: it goes to the Board, opens the Page at the Comment and marks the mentions up to it as seen.
- Empty: serif "No mentions yet", "When a Member writes @<you> in a Comment, it shows here, newest first." Loading after 150 ms: "Loading mentions…".
- The notice (`ui/shell/MentionNotice.tsx`): bottom right, `role="status"`, for 8 s (held while hovered or focused): "**Ana** mentioned you on Card <title>." **Open** ×.


---

# M19 Part 1 — a PDF on a Source

Spec: [docs/specs/pdf-sources.md](../../../docs/specs/pdf-sources.md) Part 1 (binding). Data layer: [CONTRACT.md](../lib/CONTRACT.md) "M19 Part 1". Code: `ui/page/SourcePdf.tsx` + `sourcePdfWork.ts` (the row's PDF line, the drop), `ui/page/Sources.tsx` (Fetch the PDF from arXiv), `ui/pdf/` (`PdfReader.tsx`, `PdfPage.tsx`, `layout.ts`, `find.ts`, `remember.ts`, `text.ts`, `attach.ts`, `engine.ts` + `engineImpl.ts` — pdf.js, loaded lazily with the reader), `ui/shell/searchPdf.ts`, `ui/page/bibtex/fileField.ts` + `importPdfs.ts`. Vocabulary: Source, PDF, Page, Card, Member, Guest. Never "document" or "attachment" for the Source.

## In a Source row (Page → Sources)
- A line under the row: chip "PDF" (mono 9.5 caps), the file name (mono, ellipsis, full name in `title`), "12 pages · 1.4 MB" (mono `--q-ink-3`), and **Open PDF** (small outlined button, always shown). Members also get **Replace…** and **Remove PDF**. Without a PDF, Members see **Attach PDF…** on hover/focus like Edit (`title` "Or drop a PDF file on this Source"). Guests and a moved copy: Open PDF only.
- Attaching: "Attaching “x.pdf”… 45 %", a 120px bar (`role="progressbar"`) and **Stop**; at 100 % "reading its pages". A refusal: the server's sentence in `--q-st-question` (`role="alert"`) + **Dismiss**. Not a PDF: "“notes.txt” is not a PDF. Attach a .pdf file."
- Replace (picked, or dropped on a Source that has one) asks inline: "Replace “old.pdf” with “new.pdf”? Undo brings the old one back." **Replace** (focused) / **Keep the old one**.
- Remove PDF: at once, toast "Removed the PDF from <title>." with **Undo**.
- Undo steps: "Attach a PDF to <title>", "Replace the PDF of <title>", "Remove the PDF from <title>" ("Untitled Source" without a title).
- Drop a file on the Sources section: dashed accent outline; on a row, that row tints `--q-accent-soft` and gets it; elsewhere the only Source gets it; otherwise "Drop the PDF on the Source it belongs to." / "Add the Source first, then attach its PDF."

## The Source form — Fetch the PDF from arXiv (decision 9)
- After Look up answered for an arXiv id (not a DOI; not on a Source that has a PDF): **Fetch the PDF from arXiv** (`title` "Infall’s server downloads it from arxiv.org; only the arXiv id is sent"). Asking: "Fetching the PDF…" and "Asking arXiv for arXiv:<id>… The form stays usable meanwhile." Done: "The PDF from arXiv is ready (12 pages · 1.4 MB). It is attached when you press Add Source." (Update Source when editing). Failed: the server's sentence + **Try fetching the PDF again**. Typing another identifier forgets it.

## The reader (decision 7) — in the Page panel's place
- The Page panel's box (`qp-panel`; ⤢ full width works). Header: **‹ Page** ("Back to the Page", Esc), the Source title (serif 14/600) over the file name (mono 10.5), **Save a copy** (browser, or an app without `openExternally`) / **Open in the system viewer**, ⤢, ✕ "Close the PDF". Toolbar (`role="toolbar"` "PDF", wraps when narrow): ‹ "Previous page", page field ("Page, of N") + "of N", › "Next page"; − "Zoom out", zoom `<select>` ("Fit width (87 %)", 25 %…400 %), + "Zoom in", **Fit width** (`aria-pressed`, the default; fits the widest page); **Find** at the right.
- Pages: white paper on `--q-sunken` in both themes, 12px apart, centred, a hairline and a small shadow. Only the pages in view and two either side are in the document (a 300-page PDF keeps ≤ 7); each is drawn into a new canvas that replaces the old one when ready (no blank flash on zoom), at device pixels × interface scale, capped at 16 Mpx per page. pdf.js's text layer lies over each page: selection and copy are the browser's own.
- Keys (anywhere in the reader but a field): ← / PageUp previous page, → / PageDown next, Home / End, ↑ ↓ scroll, + / − zoom, 0 fit width, ⌘F / Ctrl+F Find (also when nothing has focus), Esc closes Find, then the reader. Focus goes into the pages on open, and back to that Source's Open PDF on close.
- Find (`role="search"`): field "Find in this PDF"; status "3 of 12" / "No matches" / "Reading the text…" / "This PDF has no text to search or select." (mono, tabular); ↑ "Previous match" (⇧Enter), ↓ "Next match" (Enter), ✕ "Close Find". Matches come from the stored text (case ignored, any spacing); marks on the page are an amber tint with a 1px outline, the current one stronger (2px) — not colour alone. The current match is brought to the middle of the view; nothing scrolls smoothly.
- A PDF without text: a quiet strip under the toolbar, "This PDF has no text to search or select."
- Opening: "Opening the PDF…" after 150 ms. Failure: "The PDF could not be opened. <why>" + **Try again**.
- The page each PDF was left at is remembered on this device (`localStorage` "infall-pdf-pages", the newest 200 PDFs).

## Search (⌘K) — decision 8
- Under the Cards, a group "IN PDFS" (mono caps): one option per page — "in the PDF of **<Source title>**, page N" (two lines at most) and the snippet with the words marked (`--q-accent-soft`). Choosing it goes to the Board, focuses the Card, opens its Page, and the reader at that page with Find showing the words and that match chosen.

## Import BibTeX with files — decision 10
- When entries have a `file = {…}` field naming a PDF, a box under the file field. Desktop app: "N entries name a PDF in its file field. Pick the folder the paths start from — the one Zotero exported to, or Zotero’s storage folder — to attach them." + **Attach the PDFs…**; after picking: "PDFs from “<folder>” are attached to their Sources." + **Choose another folder…** / **Import without PDFs**. Browser: "… In a browser the entries come in without their PDFs; the desktop app can attach them."
- The import first reads and sends the PDFs ("Attaching the PDFs… 3 of 12"), then the entries; the PDFs' fields go into the same batches, so the import stays one Undo step. Report lines: "Attached 10 PDFs.", "2 PDFs were not found in “<folder>”: “a.pdf”, “b.pdf”.", "1 PDF is larger than the server takes and was left out: “x.pdf”.", "“y.pdf” could not be attached: <why>.", "1 Source already had a PDF; it was kept."; in a browser "N entries had a PDF in their file field; in a browser no PDF is attached (the desktop app can attach them)."

## Settings → About
- A card "Software licences": PDF.js (Apache License 2.0), PDF.js standard fonts (Foxit, Liberation), PDF.js image decoders (OpenJPEG, PDFium JBIG2) — files in `public/licenses/`.
