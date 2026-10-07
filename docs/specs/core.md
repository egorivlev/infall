# Qoop core — versioning rules

The rules the `qoop-core` crate must implement. Vocabulary is defined in [CONTEXT.md](../../CONTEXT.md); the reasoning is in [ADR 0001](../adr/0001-change-log-instead-of-commits-or-crdt.md). The core is pure logic: no clock, no storage, no network.

## 1. Entities and fields

Research Content on a Board is a set of entities. Each has a stable id, a kind, named fields, and is either live or deleted. Deleted entities are kept (tombstones) so they can come back.

| Kind | Content fields | Layout fields |
|---|---|---|
| Card | `title` Text, `summary` Text, `status` Text | `x`, `y`, `w`, `h` Float |
| Frame | `title` Text | `x`, `y`, `w`, `h` Float |
| Connection | `from` Ref, `to` Ref, `label` Text, `kind` Text | — |
| Block | `card` Ref, `type` Text, `text` Text, `title` Text | `order` Text |
| Source | `url`, `doi`, `title`, `authors`, `year`, `note` Text | — |
| Attachment | `card` Ref, `source` Ref | — |

- `status` is one of `idea`, `reading`, `understood`, `open_question`, `dead_end`.
- `kind` is one of `related`, `directed`, `contradicts`; unset means `related`.
- Any field may be `Null`; `Null` and "never set" are the same thing.
- Floats must be finite.
- A Connection's `from` and `to` must refer to Cards that exist on the Board (live or deleted) and are required at creation. A Connection is **visible** only while both its Cards are live; deleting a Card does not delete its Connections.
- A **Block** is one block of a Card's Page. `card` must refer to a Card; `type` is `text` (the field `text` holds Markdown with TeX math) or `visual` (a Visual: `text` holds its HTML/JavaScript source, `title` its caption; the core treats the source as opaque text). Unset `type` means `text`. Blocks of a Page are read in ascending `order` (compared as plain strings; ties broken by id). `order` is a layout field: when two Branches reorder the same Block, the target's order wins and it is not a Conflict. Two Branches changing the same Block's `text` is a field Conflict; changing different Blocks of one Page merges automatically.
- A **Source** is identified by its `url` or `doi`. An **Attachment** attaches one Source (`source`) to one Card (`card`); a Source may be attached to many Cards.
- Every Ref field is required at creation, must point at an existing entity of the right kind (live or deleted), and cannot be cleared. A Connection, Block or Attachment is **visible** only while it and everything it refers to are live; deleting a Card does not delete its Blocks or Attachments.
- An unknown field, or a value of the wrong type, is rejected.

Later kinds are added to this table; nothing else in these rules changes.

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

It is a three-way comparison of source and target against a **base**: the Board at the most recent moment known to be contained in both — the fork moment, or the source moment of the most recent Merge between the two Branches, in either direction, that is still remembered.

A Merge between two Branches stops being remembered when a Restore on the Branch it landed on goes back to a moment before it landed. Every later Merge between those same two Branches is forgotten with it, because each was computed on top of the one undone. Forgetting moves the base earlier. Usually that only means a Conflict is raised again.

**Deliberate deletes are never reversed silently.** A forgotten Merge can leave its content on both Branches with no record that they agreed, so the comparison alone could conclude that a Delete or Undelete a Member made afterwards should be reversed. Therefore: if a Merge would automatically Delete or Undelete an entity whose deleted state was changed on the target by hand (an ordinary edit — not by a Restore or a Merge) since the two Branches last agreed, that becomes a **Conflict** (edit vs delete) instead. Deleted-state changes made by a Restore do not count, so merging again after undoing a Merge still brings the work back automatically.

The automatic changes and Conflicts applied are always the ones computed from the Branches as they are at that instant; a plan that does not match them is refused.

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

A Merge cannot be applied until every Conflict has a decision. It is applied as one batch of Changes on the target, marked as a Merge. If the target or source has gained Changes since the Merge was planned, or the base is no longer the one it was planned against, applying is refused and the Merge must be planned again.

A Merge may be given a Checkpoint name. The Checkpoint is then placed on the target at the moment just before the Merge's Changes, so the way back has a name. If that name is empty or already used on the target, the Merge is refused and nothing changes.

Undoing a Merge is a Restore to the moment before it. After such a Restore, merging the same source again must bring its work back.
