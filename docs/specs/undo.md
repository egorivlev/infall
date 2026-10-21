# M15 — Undo

A slip on the Board or in a Page — a Card dragged to the wrong place, a Connection deleted by accident — has no quick way back today: History and Restore return a whole Branch to a moment, which is too heavy for a slip and takes other people's work with it. M15 adds **Undo**: Cmd/Ctrl+Z takes back the person's own last gesture.

Words are CONTEXT.md's. The decisions below were settled in a grilling on 2026-11-24.

## Decisions

1. **Whose and how long.** Undo takes back the Member's **own** edits on the **open Branch**, made in **this window since it was opened**. The list of steps lives in the window; closing the app or reloading clears it. Nothing about it is stored on the server.
2. **Honest History.** An Undo is recorded as new Changes by that Member, like any edit. History shows it; Restore can go back across it. No Change is ever removed.
3. **One step is one gesture.** One drag of five selected Cards is one step. Deleting a Card with its Connections is one step. An Import BibTeX of 500 entries is one step. Text typed in a field is one step per stay in the field (see 6).
4. **What can be undone:** edits to Research Content — adding, moving, resizing, deleting a Card, Frame or Connection; changing a title, summary, status, label or kind; everything on a Page (blocks added, removed, reordered, edited; Sources attached, detached, edited; a Visual or Run block's own content; a Pin); accepting a Suggestion; Import BibTeX. **What cannot:** a Merge, a Restore, naming a Checkpoint, starting a Branch, To-dos, Conversations, executing a Run, anything in Settings. When a Merge or a Restore lands on the open Branch — by anyone — that Branch's list of steps is cleared, and Cmd/Ctrl+Z says "Nothing to undo. To go further back, use History."
5. **Never over someone else's work — per field.** Before a step is undone, each part of it is checked against what has happened on the Branch since:
   - a field somebody else has changed since stays as it is;
   - a thing somebody else has deleted is not brought back, and a thing I added that somebody else has since edited (it or anything belonging to it: its Page, its Connections, its Sources) is not removed;
   - every other part is undone.
   When some parts were left, a quiet note says so and names who: "Undid Move 3 Cards. 1 left as it is — Ana changed it since." When every part was left: "Not undone — Ana changed this since." and the step is dropped from the list. Nobody is asked a question.
6. **Text fields.** While a field is being edited (a Card's title in place, a text block, the inspector's fields), Cmd/Ctrl+Z is the field's own text undo, as in any editor. When the field is left and its edit is sent, that edit becomes one step.
7. **Redo.** Shift+Cmd/Ctrl+Z (and Ctrl+Y on Windows and Linux) redoes the step last undone, under the same rule as 5. Any new edit clears what could be redone.
8. **One list per Branch per window.** Switching Branch keeps each Branch's list and resumes it on return. Undo never changes which Branch is open and never acts on a Branch that is not open.
9. **Depth:** the last 100 steps per Branch.
10. **A deleted thing comes back whole:** the same Card (same id) with its Page, its Sources and the Connections it had, as far as rule 5 allows (a Connection whose other end is gone is left out and counted in the note).
11. **Saying what will happen.** The Edit menu (desktop) and a tooltip on the Board's undo/redo buttons name the step: "Undo Move 3 Cards", "Redo Delete Card Axions". The words are the ones History uses for the same Changes. After an Undo or Redo a short line says what was done; it is announced to screen readers.
12. **Where it works.** Wherever the Board or a Page of the open Branch is shown and editable. Not while History shows an earlier moment, not for Guests, not in Settings or other screens (there the keys do what the focused field does, or nothing).

## How it is built

No server change. Everything is the web UI's, plus the desktop app's Edit menu.

- **Steps are recorded where ops are sent.** Every user gesture that sends ops to the open Branch registers one step: its label, and for each op the inverse op computed from the Board as it was just before (the value a field had, the full content of a thing being deleted). Ops sent by Undo and Redo themselves are marked and register nothing. Ops that arrive from other people are never steps.
- **The check in 5** uses what the client already has: the Branch's Changes since the step (it receives them live, with their authors). A step's part is "touched" when a later Change by someone else — or by me, outside this list, e.g. from another window — set the same field of the same thing, deleted the thing, or changed something belonging to a thing the step added. Later Changes of my own that are steps in this list do not block: undoing in order handles them.
- **Order.** Steps are undone strictly newest first. A step that was wholly left is dropped; the next press goes to the one before it.
- **Pure core.** `web/src/lib/undo.ts`: the inverse of each kind of op; the touched-check; the list with its undo/redo/clear rules and depth — all pure functions tested without a browser, including a randomised test: any sequence of gestures by me, interleaved with Changes by another Member, then undone as far as it goes, leaves every field either as it was before my gesture or as the other Member last set it, and never loses a Change of theirs.
- **The keys** are handled once, at the shell: when focus is in a field being edited, the event is left to the field; otherwise it goes to the open Branch's list. They must not fire with Alt, and must not collide with the Board scale keys.
- **Desktop.** The app's Edit menu's Undo and Redo items call into the page (through the bridge, main window only), show the step's name, and are disabled when there is nothing to do. In a text field they act on the field, as the system's own items do.
- **Buttons.** Undo and Redo sit in the Board's toolbar and in the Page header, icon buttons with tooltips naming the step and the keys.

## Zones

| Zone | Files |
|---|---|
| 1 Undo core | `web/src/lib/undo*.ts`, tests; the smallest hooks in the lib's op-sending path and its Change stream |
| 2 Board and Page | `web/src/ui/board/**`, `web/src/ui/page/**`, `web/src/ui/suggestions/**`, `web/src/ui/shell/**` (keys, the note): every gesture registers its step with a label; buttons |
| 3 Desktop menu | `desktop/src-tauri/src/{shell.rs,bridge.rs,bridge.js}`: Edit menu items and their state |
| 4 Docs | `docs/tutorial.md`, `docs/specs/tutorial.md` (a Tutorial step for Undo, placed after the first edit), `CONTEXT.md` already has the term |

Zone 2 depends on zone 1. Zone 3 depends on a bridge contract written in zone 1's report: the page exposes `window.__infallUndo = { state(): { undo: string | null, redo: string | null }, undo(): void, redo(): void, subscribe(fn): () => void }` and the shell reads it — the page never gets a new power.

## Done when

- Every suite is green, including the randomised test.
- Hand check in the packaged app, each followed by Cmd+Z and Shift+Cmd+Z: move one Card; move five; resize a Frame; add a Card; delete a Card that has a Page, Sources and Connections; draw and delete a Connection; change a status; edit a title in place (text undo inside, one step after); add, edit, reorder and remove Page blocks; attach a Source; Import BibTeX; accept a Suggestion.
- With a second window as another Member: they edit a title I edited — my Undo leaves it and says so; they move a Card I did not — my Undo of my own move still works; they write on the Page of a Card I added — my Undo does not remove the Card.
- Merge a Branch into the open one: Cmd+Z says nothing to undo.
- 100 steps back works; the 101st is gone without error.
- The Edit menu names the step; keyboard only and a screen reader can do all of it.

## Not in M15

Undo that survives closing the app. Undo of To-dos, Merges, Restores, Checkpoints. Undo across Branches. Undoing someone else's Changes. A visible list of steps to jump back in.
