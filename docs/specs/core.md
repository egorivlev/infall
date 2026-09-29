# Qoop core — versioning rules

The rules the `qoop-core` crate must implement. Vocabulary is defined in [CONTEXT.md](../../CONTEXT.md); the reasoning is in [ADR 0001](../adr/0001-change-log-instead-of-commits-or-crdt.md). The core is pure logic: no clock, no storage, no network.

## 1. Entities and fields

Research Content on a Board is a set of entities. Each has a stable id, a kind, named fields, and is either live or deleted. Deleted entities are kept (tombstones) so they can come back.

| Kind | Content fields | Layout fields |
|---|---|---|
| Card | `title` Text, `summary` Text, `status` Text, `color` Text | `x`, `y`, `w`, `h` Float |
| Frame | `title` Text | `x`, `y`, `w`, `h` Float |
| Connection | `from` Ref, `to` Ref, `label` Text | — |

- `status` is one of `idea`, `reading`, `understood`, `open_question`, `dead_end`.
- Any field may be `Null`; `Null` and "never set" are the same thing.
- Floats must be finite.
- A Connection's `from` and `to` must refer to Cards that exist on the Board (live or deleted) and are required at creation. A Connection is **visible** only while both its Cards are live; deleting a Card does not delete its Connections.
- An unknown field, or a value of the wrong type, is rejected.

Later kinds (Page blocks, Sources) are added to this table; nothing else in these rules changes.

## 2. Changes

A Change is one of four operations plus who made it and when:

- **Create** an entity with initial fields — rejected if the id exists.
- **Set** one field of a live entity — rejected if the entity is missing or deleted.
- **Delete** a live entity — rejected if missing or already deleted.
- **Undelete** a deleted entity — rejected if missing or live.

Each Branch has an ordered, append-only list of Changes. A rejected operation is not recorded. Concurrent edits are whatever order the server receives them in: last write to a field wins.

## 3. Branches, moments, Checkpoints

- A **moment** is a Branch plus a count of how many of its Changes have been applied (0 = the Branch as it was when created).
- The first Branch is `main`, created empty. Every other Branch is forked from a moment on another Branch, its **parent**, and starts with the parent's Board at that moment.
- Branch names are unique and non-empty.
- A Checkpoint is a name attached to a moment. Checkpoint names are unique within a Branch.

## 4. Restore

Restoring a Branch to an earlier moment on that same Branch appends the Changes that turn the current Board into the Board at that moment. Afterwards the two Boards have the same content (same live entities, same field values). Entities created after that moment become deleted, not absent. All Changes of one Restore share a batch id and are marked as a Restore.

## 5. Merge

A Merge brings a **source** Branch into a **target** Branch. In v1 a Merge is only allowed between a Branch and its direct parent, in either direction.

It is a three-way comparison of source and target against a **base**: the Board at the most recent moment known to be contained in both — the fork moment, or the source moment of the most recent Merge between the two Branches in either direction.

Per entity that exists in the base (b = base, s = source, t = target):

| Situation | Result |
|---|---|
| Deleted on both, or live on both | compare fields (below) if live on both |
| s deleted, b and t live, t changed no content field since b | Delete automatically |
| s deleted, b and t live, t changed a content field since b | **Conflict** (edit vs delete) |
| t deleted, b and s live, s changed no content field since b | stays deleted |
| t deleted, b and s live, s changed a content field since b | **Conflict** (edit vs delete) |
| b deleted, s live, t deleted | Undelete automatically, then Set every field where source differs from target to source's value |
| b deleted, t live, s deleted | nothing |

An entity absent from the base but present on both sides (it arrived by an earlier Merge that was later undone) is treated as deleted in the base with no fields.

Layout-only edits never protect an entity from deletion.

Per field, when the entity is live on both sides:

| Source vs base | Target vs base | Result |
|---|---|---|
| same | anything | nothing |
| changed | same | Set to source's value automatically |
| changed | changed to the same value | nothing |
| changed | changed to a different value, layout field | nothing — target wins |
| changed | changed to a different value, content field | **Conflict** (field) |

Entities that exist only on source are created automatically with source's fields; if deleted on source they are created and then deleted, so that Connections referring to them remain valid. Entities that exist only on target are left alone.

Each Conflict is decided by a Member: take source, take target, or (field Conflicts only) a hand-written value. For edit vs delete, "take source" means end up as source has it (deleted, or live with source's content fields) and "take target" means leave target as it is.

A Merge cannot be applied until every Conflict has a decision. It is applied as one batch of Changes on the target, marked as a Merge. If the target or source has gained Changes since the Merge was planned, applying is refused and the Merge must be planned again.

Undoing a Merge is a Restore to the moment before it. After such a Restore, merging the same source again must bring its work back.
