# M15b — the Branch Graph

Today the Branches screen is a table, and a new Branch can start only from "now" or from a Checkpoint of the Branch that happens to be open. A Member cannot see how the Branches relate, what was done on each, or start a Branch from a moment on another one. M15b replaces the table with the **Branch Graph**: every Branch drawn from the Workspace's first Change, its work visible as Activities, and any Activity or Checkpoint usable as the start of a new Branch.

Words are CONTEXT.md's. The decisions below were settled in a grilling on 2026-11-24; this spec records them and the contracts that follow. The look of the screen (colours, line shapes, spacing) is settled in M17's design pass, not here.

Nothing about versioning itself changes: no new kind of Change, no new rule for Merge, Restore or Checkpoint. The server already starts a Branch from any moment (`POST /api/branches {name, from}`) and reads the Board at any moment.

## 1. What the Member sees

### The graph

The Branches screen (`/branches`, title still **Branches**) shows one row per Activity, newest at the top, the Workspace's first Activity at the bottom.

```
main  exp-A
  │     ●   Egor  14:07  Added Card Dark-photon decay  +2
  ●     │   Ana   13:50  Edited the Page of Axions
  │     ●   Egor  13:20  Moved 3 Cards
  ◆─────┘   ◆ before-review
  ●         Ana   11:02  Added Source 10.1103/…
  ●         Egor  09:15  Added Frame Theory
```

- **Left**: one line per Branch, each in its own colour. A dot on a line is one Activity of that Branch.
- **Right of the lines**, on each row: the author, the time, the first summary line of the Activity, and "+N" when it has more lines.
- **Checkpoints** are ◆ markers on the dot where they fall, with their name. A Checkpoint at a Branch's own start (before its first Change) sits on the fork point.
- **Forks**: a Branch's line leaves its parent's line at the moment it was started from.
- **Merges**: a line joins the source moment on one Branch to the Merge dot on the other, for both *Merge into parent* and *Update from parent*. The Merge row names both Branches ("Merged exp-A into main"). A Merge that changed nothing left no Activity and is not drawn.
- **Restores** are ordinary dots with their own mark. No line is drawn back to the moment restored to.
- **Order of rows** across Branches is by the time each Activity ended. Within one Branch, order is always the Branch's own order, whatever the clocks say.
- **Each Branch's name** is a label at the top end of its line. The label carries what the table's row carried: **Open**, **Merge into parent**, **Update from parent**, who started it and when.

### Columns

A Branch's line runs from its fork to its last dot and stops there. Where that last dot was merged into the parent, the line visibly ends in the parent. A column that is free above that point is reused by a newer Branch. The graph is as wide as the number of Branches that were being worked on at the same time, not the number that ever existed. `main` always has the first column. Nothing is hidden and there is no archive.

### Activities on the graph

A dot is an Activity as History already reads it (one Member's consecutive Changes on a Branch with no pause over ten minutes; a Merge or a Restore is one Activity of its own), with one rule added everywhere, History included: **a Checkpoint always ends the Activity it falls in.** An Activity that held a Checkpoint in its middle becomes two. So a ◆ always sits exactly on a dot, and starting from the dot and starting from the ◆ are the same moment.

Two Members working on one Branch at the same time give alternating small dots, as in History today.

### Selecting a dot

Clicking a dot (or moving to it with the keyboard) selects it and shows, beside the graph, all its summary lines (the same words History uses), its Branch, author, start and end time and number of Changes, and these actions:

- **New Branch from here** — see section 2.
- **Preview the Board** — opens that Branch's Board with History showing it as it was right after this Activity, read-only, exactly as History's own preview does. Leaving the preview returns to the graph.
- **Add Checkpoint here** — asks for a name and places a Checkpoint at the moment right after this Activity. The dot gets its ◆ at once.
- **Show every Change** — lists the Activity's Changes in order, each in one line of plain words, with its time.

There is no Restore on the graph. Restore stays in the History panel of the open Branch, where it acts on the Branch the Member is looking at.

### Staying current

- A new Branch and a Merge appear at once for everybody who has the graph open.
- New dots on the open Branch appear as they happen.
- New dots on other Branches appear when the graph is opened or the window gets focus again.

### Guests

A Guest has no Branch Graph, as a Guest has no Branches screen today.

## 2. Starting a Branch

There is one way to choose where a Branch starts: the graph.

- **New Branch…** in the Branch switcher opens the graph with the newest dot of the open Branch selected and the name field focused. Typing a name and pressing Enter starts the Branch from now: no more effort than today.
- Clicking any other dot or ◆, on any Branch, before pressing Enter moves the start there. The field says where it will start in words: "from now on main", "from Checkpoint before-review on main", "from Ana's work at 13:50 on exp-A".
- **New Branch from here** on a selected dot opens the same name field with that dot chosen.
- A Branch with no Changes yet is started from by selecting its fork point.

The moment used is the one right after the selected Activity, or the Checkpoint's own moment. The new Branch's parent is the Branch the dot is on; it merges with that Branch, as now.

On success the new Branch is opened. Errors are the existing ones (name taken, name too long), shown at the field.

The **Start from** dropdown and the separate New Branch panel are removed.

## 3. Contracts

### Server

One new endpoint, documented in `docs/specs/api.md`. Members and Admins only; a Guest gets `403`.

`GET /api/graph?gap_ms=600000` returns the shape of every Branch without the contents of any Change:

```json
{
  "branches": [
    {
      "id": "…", "name": "exp-A", "seq": 41,
      "parent": { "branch": "…", "seq": 120 },
      "created_by": "…", "created_at": 1795000000000,
      "checkpoints": [{ "name": "before-review", "seq": 12, "author": "…", "at": 1795000000000 }],
      "activities": [
        { "kind": "edit", "author": "…", "from_seq": 0, "to_seq": 12, "started_at": 0, "ended_at": 0 },
        { "kind": "merge", "author": "…", "from_seq": 12, "to_seq": 30, "started_at": 0, "ended_at": 0,
          "source": { "branch": "…", "seq": 140 } },
        { "kind": "restore", "author": "…", "from_seq": 30, "to_seq": 41, "started_at": 0, "ended_at": 0, "to": 12 }
      ]
    }
  ]
}
```

- An Activity covers the Changes `(from_seq, to_seq]` of its Branch. The Activities of a Branch are in order, do not overlap, and together cover `(0, seq]`.
- The grouping rule is the one in section 1, including the split at Checkpoints. `gap_ms` is the longest pause inside one Activity of kind `edit`; the client sends its own constant so the number lives in one place.
- The response is built in one pass over each Branch's log. It must not rebuild any Board.

`GET /api/branches/{id}/changes` gains an optional `before=M`: Changes with index in `[after, before)`. Without it, behaviour is unchanged.

Nothing else on the server changes. The `branches` socket frame stays the signal that a Branch or a Merge was added.

### Web

- **The grouping rule lives twice** (Rust for the graph, `web/src/lib/activities.ts` for History) and must agree. One shared fixture, a Change log with the Activities expected from it, is read by a test on each side. `groupActivities` gains the split at Checkpoints.
- **Shape first.** The graph is drawn from `/api/graph` alone: lines, dots, forks, Merges, Checkpoints, authors and times, back to the start.
- **Text lazily.** Summary lines are worked out only for rows on screen (and a margin around them): for each Branch with rows in view, the client reads the Board at the earliest needed moment once (`board?at=`), reads the Changes of the range (`changes?after=&before=`), and runs `describeChanges` forward. Results are kept for the life of the screen. A row whose text has not arrived shows author and time and a quiet placeholder; rows never change height when text arrives.
- **Only rows on screen are in the document.** The graph must stay usable with the 50 000-Change Workspace from M15's generator.
- Layout (which column each Branch gets, where rows go) is a pure function of the `/api/graph` response, tested without a browser.

### Keyboard and access

- `↑`/`↓` move between rows; `←`/`→` move to the nearest dot on the neighbouring line; `Enter` on a dot opens its actions; `N` starts a Branch from the selected dot; `Esc` leaves the name field, then the selection.
- Every dot is reachable by keyboard and has a spoken name: Branch, author, time, first summary line, and its Checkpoint if any. Colour is never the only thing that tells two Branches apart: the line's label and the selected dot's detail both name the Branch.
- Reduced motion: no animated lines or scrolling.
- Both themes; colours from theme tokens. Narrow windows: the text column shrinks first, then the graph scrolls sideways; the page itself never does.

## 4. Zones

| Zone | Files |
|---|---|
| 1 Server | `crates/**`, `docs/specs/api.md` |
| 2 Graph logic | `web/src/lib/graph*.ts`, `web/src/lib/activities.ts`, `web/src/lib/history.ts`, `web/src/lib/branches*.ts`, their tests, the shared fixture |
| 3 Graph screen | `web/src/ui/shell/Branches.tsx` and what it needs under `web/src/ui/branches/**`, `BranchSwitcher.tsx`; removes `NewBranch.tsx` |
| 4 History | `web/src/ui/history/**` (Activities now end at Checkpoints; preview reachable from the graph) |
| 5 Docs | `docs/tutorial.md`, `docs/specs/tutorial.md` and `docs/specs/local.md` where a step names the old panel or table, `web/src/ui/DESIGN.md`, `README.md`, `CONTEXT.md` |

Zone 2 depends on zone 1's response shape, fixed above. Zones 3 and 4 depend on zone 2.

## 5. To check before building

- The hands-on Tutorial ([local.md](local.md#the-tutorial-web-ui)) and the Tour step "The Branch switcher" may point at controls this spec removes. Each such step is re-pointed, not dropped.
- `CONTEXT.md`'s **Merge** reads as any Branch into any other; the code and [core.md](core.md) allow only a Branch and its direct parent. Not changed here, but the graph makes it visible; correct the glossary or lift the limit, as a separate decision.
- [api.md](api.md) still says in one place that a Guest may read `/changes` on main; the code refuses. Fix the line with the other `api.md` edits.

## 6. Done when

- Every suite is green, including the shared-fixture test on both sides.
- With the 50 000-Change Workspace: the graph's shape is on screen within the limit M15 wrote down for History, scrolling stays smooth, and text fills in without rows jumping.
- Hand check in the packaged app:
  1. Open Branches: every Branch is there from the first Change, forks and Merges where they happened.
  2. Start a Branch from now with name + Enter.
  3. Start a Branch from an unnamed dot on a Branch that is not open.
  4. Start a Branch from a Checkpoint; it starts at exactly that moment (Preview the Board agrees).
  5. Add a Checkpoint to an old dot from the graph; History on that Branch shows it, and the Activity around it is split there.
  6. Merge a Branch into its parent and update one from its parent; both lines appear at once in a second window.
  7. Show every Change on a dot; the count matches.
  8. Do all of the above with the keyboard only.
  9. Sign in as a Guest: no Branches screen, `/api/graph` refused.

## Not in M15b

Restore from the graph. Hiding or archiving Branches. Deleting or renaming a Branch or a Checkpoint. Merges other than between a Branch and its parent. Dots of other Branches appearing live. Drawing Merges that changed nothing. Comparing two moments. Search or filter in the graph.
