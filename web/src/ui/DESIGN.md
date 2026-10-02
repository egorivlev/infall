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
