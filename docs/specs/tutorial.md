# M11 — the Tour and the written tutorial

A new team member opens Infall and sees a Board they did not build. M11 gives them two things: a short Tour inside the app that points at the real controls, and a written tutorial they can read next to it. Neither changes what Infall can do, and neither writes anything to the Board.

Words are CONTEXT.md's. The **Tour** (section 1) is read-only and points at controls. The **Tutorial** is something else: hands-on steps in a Tutorial Workspace that wait for the Member to do each thing, added in M12 and specified in [local.md](local.md#the-tutorial-web-ui), not here; since M15 it has eighteen steps, step 3 being Undo (a slip made on purpose and taken back, right after the first Card of one's own). The Tutorial runs only in a Tutorial Workspace; every other Workspace keeps the Tour as specified below. The written tutorial (section 2) is a page in `docs/`, neither of the two.

## 1. The Tour (in the app)

### What it is

A sequence of steps. Each step is a small popover anchored to one real control, with a ring around that control: a title, one to three plain sentences, "Step 3 of 11", and **Back**, **Next** (on the last step: **Done**) and **Skip the tour**. Nothing else is dimmed or blocked: the Member can use the app while the Tour is open, and the popover follows its control.

The Tour never changes the Board, a Page or anything on the server. It only opens and closes what the Member could open themselves (a panel, a route), and only when a step needs it.

### When it shows

- **Offered once**: the first time a Member is signed in on a device, a small card in the bottom-right corner says "New here? Take a two-minute tour of Infall." with **Start the tour** and **Not now**. Either answer is remembered on that device for that Member (`localStorage`, key per Member id), and the card never comes back by itself.
- **Always available**: the account menu has an item **Tour of Infall**, which starts it from step 1.
- Never on the access screens (login, invite), never while a merge is open, and never for a window narrower than the layout supports.
- If `localStorage` cannot be read or written, the offer is simply not shown; the menu item still works.

### The steps

For a Member or an Admin, in this order. The text of each step is written by the builder in the project's words (CONTEXT.md), short, and says what the control is for, not how the tutorial works.

1. **The Board** — the canvas: Cards are the team's ideas, papers and questions; drag to move, scroll to pan.
2. **+ Card / + Frame** — how a Card and a Frame are made; since M15 also that the arrows beside them are Undo and Redo of one's own latest gestures (no step of their own).
3. **A Card** (the first one on the Board, if there is one; otherwise this step stays on "+ Card") — its status, and that opening it shows its Page.
4. **Connections** — drawn from one Card to another, with a label (anchored to the Board; says where to drag from).
5. **Search** — finds Cards; the keyboard shortcut.
6. **The rail** — To-dos, Suggestions, Branches (the Branch Graph, since M15b) (and Members, for an Admin).
7. **The Branch switcher** — a Branch is a private line of work; `main` is what everybody shares; its **New Branch…** opens the Branch Graph, where any moment can be where a new Branch starts (M15b).
8. **Checkpoint and History** — name a moment; go back and look.
9. **The AI sidebar** — asks about the Board; private Conversation; "Pin to Page".
10. **Runs** — code on a Page runs in the desktop app only, on the Member's own computer, after they approve it. In a browser the step says that the result of the last Run is shown instead.
11. **Where to read more** — the written tutorial, and that this tour is in the account menu. In the desktop app (M12, [local.md](local.md#the-tutorial-web-ui)) it also says that a Tutorial Workspace can be made from the start screen, with a button that goes there.

A Guest gets a shorter tour (Board, a Card and its Page, Search, and that a Guest reads and does not change): no step may point at something a Guest cannot see.

A step whose control is not on screen right now (a narrow window, a control that role does not have) is skipped, not shown broken. If the tour would have fewer than three steps left, it does not start.

### Behaviour

- Keyboard: `Esc` ends the tour; `←`/`→` go back and forward when focus is in the popover; focus moves to the popover when a step opens and returns to where it was when the tour ends; Tab stays usable for the rest of the app (it is not a modal).
- Screen readers: the popover is a `dialog` that is not modal, labelled by its title; the step count is read with it.
- Reduced motion: no movement between steps, the popover appears in place.
- The ring and the popover take their colours from the theme tokens; both themes.
- Resizing, scrolling or a layout change keeps the popover on its control; if the control goes away, the step ends as "skipped" and the tour moves on.
- Leaving the Board route for another by hand ends the tour quietly.

### Not in M11

Steps that wait for the Member to do something, a sample Board, videos, progress kept on the server, translation. (M12 adds the first three for the Tutorial in a Tutorial Workspace, [local.md](local.md#the-tutorial-web-ui); the Tour itself still has none of them.)

## 2. The written tutorial

`docs/tutorial.md`: one page, read top to bottom in about fifteen minutes, that takes one person from an empty Board to having used every main part once: a Card, its Page (text, math, a Visual, a Source), a Connection, a Frame, a To-do, a Suggestion, a Branch with a Checkpoint and a merge back, History, the AI sidebar (both ways of connecting it, said honestly: which needs what), a Run in the desktop app, and inviting a Guest.

- Every control is named exactly as the screen names it; every sentence was checked against the source or the running app.
- It says what is not there (Runs only in the desktop app; one Run at a time; until M15, no general undo) where a reader would otherwise look for it. Since M15 it has a short part on Undo: what it takes back, the keys and buttons, and what it never does.
- `docs/first-day.md` links to it as the next thing to read, and the Tour's last step names it.
- Since M12 it starts with the way in for someone without a team (the desktop app, a Tutorial Workspace) and says which parts do not exist in a Local Workspace (Members, invites, Guests).
