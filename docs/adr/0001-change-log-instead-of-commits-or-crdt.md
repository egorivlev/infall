# Research Content is an append-only log of field-level Changes

Qoop needs live updates between Members, full history with fall-back, and git-like Branches that Merge. We record every edit automatically as a field-level Change in an append-only log, and derive live sync, history, Restore, branching and three-way Merge from that one log. There is no commit step, and Restore appends undoing Changes rather than erasing history.

## Considered Options

- **Explicit git-style commits** — rejected: with a shared live Board there is no sensible owner of "uncommitted" work, and people forget to commit, leaving holes in history.
- **CRDT (Yjs/Automerge) everywhere** — rejected: buys character-level co-editing that four people rarely need, at the cost of adopting its storage model. Same-field concurrent edits use last-write-wins; Page bodies use a soft lock. A CRDT can be introduced for the Page editor alone later without changing the Branch model.

## Consequences

- Only Research Content is versioned. To-dos, Conversations and accounts are deliberately outside Branches: a To-do ticked is a fact about the world and must not revert on a Branch switch.
- Layout disagreements during a Merge auto-resolve to the target Branch and are not Conflicts, so a merged Board may need manual tidying.
