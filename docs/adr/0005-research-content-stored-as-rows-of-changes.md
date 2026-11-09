# Research Content is stored as rows of Changes, without a snapshot

Until schema version 5 the store kept the whole `Workspace` as one JSON row and wrote all of it again on every edit: 60–115 ms an edit at 50 000 Changes, growing with every Change, and the whole file's worth of disk writes each time (docs/specs/scale.md). Since version 6 the Research Content is the append-only log it already was in the core ([ADR 0001](0001-change-log-instead-of-commits-or-crdt.md)), kept as such: a row per Branch, per Change (key: Branch, position), per Checkpoint and per sync point, and saving writes only what is not stored yet. An edit inserts its Changes and nothing else. The start reads every row; there is no snapshot of the Board or of the Workspace.

The file format only moves forward: an older build refuses a version 6 file (`NewerVersion` for Workspace files), and every file of versions 1–5 is migrated on first open, with a copy kept beside it until the migration has verifiably succeeded (docs/specs/api.md §2).

## Considered Options

- **Keep the JSON row, write it less often** (batching, writing in the background) — rejected: the cost per write still grows with the history, and a Change the server has confirmed could be lost.
- **Changes in a table plus a periodic snapshot of the Workspace or the head Boards** — not now: the start without one is about 0.1 s at 50 000 Changes, well inside the 2 s target, and a snapshot is a second copy of the history that has to be kept in step with it, written somewhere, and invalidated by Restore and Merge. It can be added later without changing the tables.
- **Every field of an op in columns** (an entity id, a field name, a value per row) — rejected: the core's `Op` already has a stable JSON form (the wire shape of api.md §5), so it is kept as one text column; the columns are what a query or a later migration needs to reach: Branch, position, id, author, time and origin.

## Consequences

- Edits cost the same at any length of history (about 9 ms at 50 000 Changes, of which the commit is a few pages); a guard in `tests/scale.rs` counts the bytes an edit writes.
- Files are about 20 % larger (the ids of the Branch, the Change and its author are text in every row), and the start parses one row per Change: 93 ms instead of 47 ms at 50 000 Changes from a cold file.
- Who wrote a Change is a column (`changes.author`), so handing one Member's work to another — as moving a Local Workspace onto a Team server will (docs/specs/team-move.md) — is one `UPDATE`, not a rewrite of the history.
- Saving takes a whole `Workspace` and compares it with what is stored (the last stored Change, Checkpoint and sync points of each Branch). That holds only because the core only ever appends Changes and Checkpoints; if it ever changed a recorded Change, the store would have to be told what changed.
