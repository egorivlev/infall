# Infall Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure-logic Rust crate that records Changes to a Board, forks Branches, names Checkpoints, Restores, and three-way Merges with Conflicts.

**Architecture:** A Board is a map of entities with fields; four operations mutate it. A Workspace holds Branches, each an append-only list of Changes on top of a parent moment; any moment's Board is rebuilt by replay. Restore and Merge are both "compute a list of operations, append them as one batch". No clock, storage, or network: callers pass timestamps and ids, and everything derives `serde` so a later storage plan can persist it.

**Tech Stack:** Rust 1.96 (edition 2024), `uuid` 1 (features `v4`, `serde`), `serde` 1 (feature `derive`), `thiserror` 2; dev-only: `serde_json` 1, `proptest` 1.

**Spec:** [docs/specs/core.md](../specs/core.md) — read it first. Vocabulary: [CONTEXT.md](../../CONTEXT.md).

## Global Constraints

- The word "commit" never appears in an identifier, comment, or message; a recorded edit is a `Change`. Use the CONTEXT.md terms: Board, Card, Frame, Connection, Branch, Checkpoint, Restore, Merge, Conflict.
- No `std::time`, no file or network IO, no `unsafe`, no `unwrap`/`expect`/`panic!` outside tests.
- Every public type derives `Debug, Clone, PartialEq, Serialize, Deserialize`; id types also `Copy, Eq, Ord, Hash`.
- Every fallible public function returns a `thiserror` enum; a failed call leaves its `&mut self` unchanged.
- All output orderings are deterministic: iterate entities by id, fields by name.
- `cargo test -p infall-core` and `cargo clippy -p infall-core --all-targets -- -D warnings` pass at the end of every task.
- Status values, exactly: `idea`, `reading`, `understood`, `open_question`, `dead_end`.

## Review Focus

1. The target Branch gains a Change while a Member is still deciding Conflicts — applying the stale Merge must be refused, not silently overwrite the new edit. (Task 7)
2. A Merge is undone with Restore and the same source is merged again — its work must come back, not be skipped as "already merged". (Task 7)
3. A hand-written Conflict value is invalid (wrong type, bad status) — the whole Merge is refused and the target has zero new Changes. (Task 7)
4. One Branch deletes a Card while the other draws a Connection to it — the Merge succeeds, the Connection is invisible, and becomes visible if the Card is undeleted. (Task 6)
5. Restore to the current moment, or to a moment past the end of the Branch — the first records nothing, the second is an error. (Task 5)

## File Structure

```
Cargo.toml                    workspace manifest
.gitignore                    target/
crates/core/Cargo.toml        package infall-core
crates/core/src/lib.rs        module declarations + re-exports
crates/core/src/ids.rs        EntityId, MemberId, BranchId, ChangeId, BatchId
crates/core/src/schema.rs     Value, EntityKind, Fields, field classes, validation
crates/core/src/board.rs      Entity, Op, Board, ApplyError
crates/core/src/diff.rs       diff_ops
crates/core/src/workspace.rs  Moment, Change, Origin, Checkpoint, Branch, Workspace, restore
crates/core/src/merge.rs      three_way, resolve, MergePlan, plan_merge, apply_merge
crates/core/tests/common/mod.rs   test helpers shared by integration tests
crates/core/tests/*.rs        one integration test file per task
```

---

### Task 1: Scaffold, ids, and schema

**Files:**
- Create: `Cargo.toml`, `.gitignore`, `crates/core/Cargo.toml`, `crates/core/src/lib.rs`, `crates/core/src/ids.rs`, `crates/core/src/schema.rs`
- Test: `crates/core/tests/schema.rs`

**Interfaces:**
- Produces:
  ```rust
  // ids.rs — five newtypes over uuid::Uuid, each with `pub fn new() -> Self` (random v4)
  pub struct EntityId(pub Uuid); pub struct MemberId(pub Uuid); pub struct BranchId(pub Uuid);
  pub struct ChangeId(pub Uuid); pub struct BatchId(pub Uuid);

  // schema.rs
  pub enum Value { Null, Float(f64), Text(String), Ref(EntityId) }
  pub enum EntityKind { Card, Frame, Connection }
  pub type Fields = std::collections::BTreeMap<String, Value>;
  pub enum FieldClass { Content, Layout }
  pub fn field_class(kind: EntityKind, field: &str) -> Option<FieldClass>;   // None = unknown field
  pub fn validate_field(kind: EntityKind, field: &str, value: &Value) -> Result<(), SchemaError>;
  pub enum SchemaError { UnknownField { kind: EntityKind, field: String }, WrongType { field: String }, NotFinite { field: String }, BadStatus(String) }
  ```

- [ ] **Step 1: Create the workspace.** `git init`; root `Cargo.toml` with `[workspace] members = ["crates/core"]`, `resolver = "3"`; package `infall-core`, edition 2024, the dependencies from Tech Stack; `.gitignore` containing `target/`; `lib.rs` declaring `pub mod ids; pub mod schema;` and re-exporting their items.

- [ ] **Step 2: Write the failing tests** in `crates/core/tests/schema.rs`:

```rust
use infall_core::*;

#[test] fn field_classes_follow_the_spec_table() {
    for f in ["title", "summary", "status", "color"] { assert_eq!(field_class(EntityKind::Card, f), Some(FieldClass::Content)); }
    for f in ["x", "y", "w", "h"] {
        assert_eq!(field_class(EntityKind::Card, f), Some(FieldClass::Layout));
        assert_eq!(field_class(EntityKind::Frame, f), Some(FieldClass::Layout));
        assert_eq!(field_class(EntityKind::Connection, f), None);
    }
    for f in ["from", "to", "label"] { assert_eq!(field_class(EntityKind::Connection, f), Some(FieldClass::Content)); }
    assert_eq!(field_class(EntityKind::Frame, "summary"), None);
}
#[test] fn accepts_valid_values_and_null_everywhere() {
    assert!(validate_field(EntityKind::Card, "title", &Value::Text("Surface codes".into())).is_ok());
    assert!(validate_field(EntityKind::Card, "x", &Value::Float(12.5)).is_ok());
    assert!(validate_field(EntityKind::Card, "status", &Value::Text("dead_end".into())).is_ok());
    assert!(validate_field(EntityKind::Connection, "from", &Value::Ref(EntityId::new())).is_ok());
    assert!(validate_field(EntityKind::Card, "title", &Value::Null).is_ok());
}
#[test] fn rejects_bad_values() {
    assert!(matches!(validate_field(EntityKind::Card, "nope", &Value::Null), Err(SchemaError::UnknownField { .. })));
    assert!(matches!(validate_field(EntityKind::Card, "title", &Value::Float(1.0)), Err(SchemaError::WrongType { .. })));
    assert!(matches!(validate_field(EntityKind::Card, "x", &Value::Float(f64::NAN)), Err(SchemaError::NotFinite { .. })));
    assert!(matches!(validate_field(EntityKind::Card, "x", &Value::Float(f64::INFINITY)), Err(SchemaError::NotFinite { .. })));
    assert!(matches!(validate_field(EntityKind::Card, "status", &Value::Text("done".into())), Err(SchemaError::BadStatus(_))));
}
#[test] fn values_round_trip_through_json() {
    let v = Value::Ref(EntityId::new());
    assert_eq!(serde_json::from_str::<Value>(&serde_json::to_string(&v).unwrap()).unwrap(), v);
}
```

- [ ] **Step 3: Run** `cargo test -p infall-core --test schema` — Expected: FAIL to compile (items not defined).
- [ ] **Step 4: Implement `ids.rs` and `schema.rs`** to the Interfaces block and spec §1.
- [ ] **Step 5: Run** `cargo test -p infall-core` and the clippy command — Expected: 4 passed, no warnings.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(core): scaffold crate with ids and field schema"`

---

### Task 2: Board and operations

**Files:**
- Create: `crates/core/src/board.rs`, `crates/core/tests/common/mod.rs`
- Modify: `crates/core/src/lib.rs`
- Test: `crates/core/tests/board.rs`

**Interfaces:**
- Consumes: Task 1 items.
- Produces:
  ```rust
  pub struct Entity { pub kind: EntityKind, pub fields: Fields, pub deleted: bool }
  impl Entity { pub fn get(&self, field: &str) -> &Value; }            // &Value::Null when unset
  pub enum Op {
      Create { entity: EntityId, kind: EntityKind, fields: Fields },
      Set { entity: EntityId, field: String, value: Value },
      Delete { entity: EntityId },
      Undelete { entity: EntityId },
  }
  pub struct Board { /* BTreeMap<EntityId, Entity> */ }
  impl Board {
      pub fn new() -> Self;
      pub fn apply(&mut self, op: &Op) -> Result<(), ApplyError>;
      pub fn get(&self, id: EntityId) -> Option<&Entity>;
      pub fn entities(&self) -> impl Iterator<Item = (EntityId, &Entity)>;   // by id, includes deleted
      pub fn is_visible(&self, id: EntityId) -> bool;
      pub fn same_content(&self, other: &Board) -> bool;
  }
  pub enum ApplyError { AlreadyExists(EntityId), UnknownEntity(EntityId), Deleted(EntityId), NotDeleted(EntityId), MissingEndpoint(EntityId), BadEndpoint(EntityId), Schema(SchemaError) }
  // tests/common/mod.rs
  pub fn card(title: &str) -> (EntityId, Op);                           // Create Card with only `title`
  pub fn connect(from: EntityId, to: EntityId) -> (EntityId, Op);       // Create Connection
  pub fn set(entity: EntityId, field: &str, value: Value) -> Op;
  pub fn text(s: &str) -> Value;
  ```
- Semantics the signatures leave open: a `Null` value is never stored (setting `Null` removes the key; `Null` entries in `Create` are dropped). `is_visible`: live, and for a Connection both endpoints live. `same_content`: equal sets of live entity ids with equal kind and fields; deleted entities are ignored. `MissingEndpoint`: Connection created without `from`/`to`, or either set to `Null`. `BadEndpoint`: `from`/`to` refers to an id that is absent or not a Card (a deleted Card is accepted).

- [ ] **Step 1: Write the failing tests** in `crates/core/tests/board.rs` (`mod common; use common::*; use infall_core::*;`):

```rust
#[test] fn create_then_set_changes_one_field() {
    let mut b = Board::new(); let (id, op) = card("Grover search"); b.apply(&op).unwrap();
    b.apply(&set(id, "x", Value::Float(40.0))).unwrap();
    let e = b.get(id).unwrap();
    assert_eq!(e.get("title"), &text("Grover search")); assert_eq!(e.get("x"), &Value::Float(40.0)); assert_eq!(e.get("summary"), &Value::Null);
}
#[test] fn rejected_operations_leave_the_board_unchanged() {
    let mut b = Board::new(); let (id, op) = card("A"); b.apply(&op).unwrap(); let before = b.clone();
    assert_eq!(b.apply(&op), Err(ApplyError::AlreadyExists(id)));
    assert!(matches!(b.apply(&set(id, "nope", Value::Null)), Err(ApplyError::Schema(_))));
    let ghost = EntityId::new();
    assert_eq!(b.apply(&set(ghost, "title", text("x"))), Err(ApplyError::UnknownEntity(ghost)));
    assert_eq!(b.apply(&Op::Undelete { entity: id }), Err(ApplyError::NotDeleted(id)));
    assert_eq!(b, before);
}
#[test] fn delete_keeps_a_tombstone_that_can_come_back() {
    let mut b = Board::new(); let (id, op) = card("A"); b.apply(&op).unwrap();
    b.apply(&Op::Delete { entity: id }).unwrap();
    assert!(b.get(id).unwrap().deleted); assert!(!b.is_visible(id));
    assert_eq!(b.apply(&set(id, "title", text("B"))), Err(ApplyError::Deleted(id)));
    assert_eq!(b.apply(&Op::Delete { entity: id }), Err(ApplyError::Deleted(id)));
    b.apply(&Op::Undelete { entity: id }).unwrap();
    assert_eq!(b.get(id).unwrap().get("title"), &text("A"));
}
#[test] fn connection_endpoints_are_checked() {
    let mut b = Board::new(); let (a, op) = card("A"); b.apply(&op).unwrap();
    let ghost = EntityId::new(); let (_, bad) = connect(a, ghost);
    assert_eq!(b.apply(&bad), Err(ApplyError::BadEndpoint(ghost)));
    let c = EntityId::new();
    assert_eq!(b.apply(&Op::Create { entity: c, kind: EntityKind::Connection, fields: Fields::new() }), Err(ApplyError::MissingEndpoint(c)));
}
#[test] fn connection_hides_while_an_endpoint_is_deleted() {
    let mut b = Board::new(); let (a, o1) = card("A"); let (z, o2) = card("Z"); b.apply(&o1).unwrap(); b.apply(&o2).unwrap();
    let (c, o3) = connect(a, z); b.apply(&o3).unwrap(); assert!(b.is_visible(c));
    b.apply(&Op::Delete { entity: z }).unwrap(); assert!(!b.is_visible(c)); assert!(!b.get(c).unwrap().deleted);
    b.apply(&Op::Undelete { entity: z }).unwrap(); assert!(b.is_visible(c));
}
#[test] fn same_content_ignores_tombstones_and_null() {
    let (id, op) = card("A"); let mut a = Board::new(); a.apply(&op).unwrap(); let mut b = a.clone();
    let (gone, op2) = card("gone"); b.apply(&op2).unwrap(); b.apply(&Op::Delete { entity: gone }).unwrap();
    b.apply(&set(id, "summary", Value::Null)).unwrap();
    assert!(a.same_content(&b));
    b.apply(&set(id, "summary", text("s"))).unwrap(); assert!(!a.same_content(&b));
}
```

- [ ] **Step 2: Run** `cargo test -p infall-core --test board` — Expected: FAIL to compile.
- [ ] **Step 3: Implement `tests/common/mod.rs` and `board.rs`** to the Interfaces block and spec §1–2. `apply` validates fully before mutating.
- [ ] **Step 4: Run** tests and clippy — Expected: all pass.
- [ ] **Step 5: Commit** — `git commit -am "feat(core): board state and the four operations"` (after `git add -A`)

---

### Task 3: Diff between two Boards

**Files:**
- Create: `crates/core/src/diff.rs`
- Modify: `crates/core/src/lib.rs`, `crates/core/tests/common/mod.rs`
- Test: `crates/core/tests/diff.rs`

**Interfaces:**
- Consumes: `Board`, `Op`.
- Produces:
  ```rust
  /// Operations that, applied in order to `from`, give a Board with the same content as `to`.
  pub fn diff_ops(from: &Board, to: &Board) -> Vec<Op>;
  // tests/common/mod.rs — used by Tasks 3, 5, 6
  /// Turns arbitrary bytes into operations and applies the valid ones; returns the ops that were accepted.
  pub fn scribble(board: &mut Board, seed: &[u8]) -> Vec<Op>;
  ```
- Output order: Creates of Cards and Frames, Creates of Connections, Undeletes, Sets, Deletes; within each group by entity id then field name. An entity that is deleted in `to` and absent from `from` is Created and then Deleted (a live Connection in `to` may refer to it). An entity live in `from` and absent from `to` is Deleted. Fields are compared only for entities live in `to`.
- `scribble`: read the seed three bytes at a time as (action, pick, payload); action mod 6 chooses create Card / create Connection between two picked existing Cards / set `title` / set `x` / Delete / Undelete on the picked existing entity; skip any op `apply` rejects.

- [ ] **Step 1: Write the failing tests** in `crates/core/tests/diff.rs`:

```rust
#[test] fn diff_of_equal_boards_is_empty() { /* build a board with two cards; assert diff_ops(&b, &b.clone()).is_empty() */ }
#[test] fn diff_orders_undelete_before_set_and_set_before_delete() {
    // from: A deleted(title "A"), B live.   to: A live with title "A2", B deleted.
    // assert ops == [Undelete A, Set A.title = "A2", Delete B]
}
#[test] fn diff_creates_cards_before_the_connections_that_need_them() {
    // from: empty.  to: two cards and a connection.  Apply diff_ops to an empty Board: every op succeeds.
}
proptest::proptest! {
    #[test] fn applying_the_diff_reaches_the_target(a in proptest::collection::vec(proptest::num::u8::ANY, 0..90),
                                                   b in proptest::collection::vec(proptest::num::u8::ANY, 0..90)) {
        let mut from = Board::new(); scribble(&mut from, &a);
        let mut to = from.clone(); scribble(&mut to, &b);
        // forward: later state from earlier; backward: earlier state from later (this is Restore)
        for (x, y) in [(&from, &to), (&to, &from)] {
            let mut w = x.clone();
            for op in diff_ops(x, y) { proptest::prop_assert!(w.apply(&op).is_ok()); }
            proptest::prop_assert!(w.same_content(y));
        }
    }
}
```
Write the three example tests out in full with the helpers; the comments above state their exact assertions.

- [ ] **Step 2: Run** `cargo test -p infall-core --test diff` — Expected: FAIL to compile.
- [ ] **Step 3: Implement `scribble` and `diff_ops`.**
- [ ] **Step 4: Run** tests and clippy — Expected: all pass (proptest runs 256 cases).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(core): diff between two boards"`

---

### Task 4: Workspace — Changes, Branches, Checkpoints

**Files:**
- Create: `crates/core/src/workspace.rs`
- Modify: `crates/core/src/lib.rs`
- Test: `crates/core/tests/workspace.rs`

**Interfaces:**
- Consumes: `Board`, `Op`, `ApplyError`, ids.
- Produces:
  ```rust
  pub struct Moment { pub branch: BranchId, pub seq: u64 }        // seq = number of the branch's own Changes applied
  pub enum Origin { Edit, Restore { batch: BatchId, to_seq: u64 }, Merge { batch: BatchId, source: Moment } }
  pub struct Change { pub id: ChangeId, pub author: MemberId, pub at: i64, pub op: Op, pub origin: Origin }
  pub struct Checkpoint { pub name: String, pub moment: Moment, pub author: MemberId, pub at: i64 }
  pub struct SyncPoint { pub base: Moment, pub landed: Option<Moment> }   // used by Task 7; a fork has landed = None
  pub struct Branch { /* private */ }
  impl Branch {
      pub fn id(&self) -> BranchId; pub fn name(&self) -> &str;
      pub fn parent(&self) -> Option<Moment>;                     // None only for main
      pub fn changes(&self) -> &[Change];
      pub fn sync_points(&self) -> &[SyncPoint];                  // a forked branch starts with [SyncPoint { base: parent moment, landed: None }]
  }
  pub struct Workspace { /* private */ }
  impl Workspace {
      pub fn new() -> (Workspace, BranchId);                      // creates the empty branch named "main"
      pub fn branch(&self, id: BranchId) -> Option<&Branch>;
      pub fn branch_by_name(&self, name: &str) -> Option<&Branch>;
      pub fn branches(&self) -> impl Iterator<Item = &Branch>;
      pub fn head(&self, branch: BranchId) -> Result<Moment, WsError>;
      pub fn board_at(&self, moment: Moment) -> Result<Board, WsError>;
      pub fn record(&mut self, branch: BranchId, author: MemberId, at: i64, op: Op) -> Result<Moment, WsError>;  // Origin::Edit; returns the new head
      pub fn fork(&mut self, name: &str, from: Moment, author: MemberId, at: i64) -> Result<BranchId, WsError>;
      pub fn checkpoint(&mut self, name: &str, moment: Moment, author: MemberId, at: i64) -> Result<(), WsError>;
      pub fn checkpoints(&self, branch: BranchId) -> Vec<&Checkpoint>;   // ordered by moment.seq then name
      pub(crate) fn append_batch(&mut self, branch: BranchId, author: MemberId, at: i64, ops: Vec<Op>, origin: Origin) -> Result<Moment, WsError>;  // all-or-nothing
  }
  pub enum WsError { UnknownBranch(BranchId), BadMoment(Moment), NameTaken(String), EmptyName, Apply(ApplyError) }
  ```
- `board_at` replays: the parent's Board at the fork moment, then this Branch's first `seq` Changes. `BadMoment` when `seq` exceeds the Branch's Change count. Names are trimmed before the empty and uniqueness checks.

- [ ] **Step 1: Write the failing tests** in `crates/core/tests/workspace.rs`:

```rust
#[test] fn recording_advances_the_head_and_rejections_do_not() {
    let (mut ws, main) = Workspace::new(); let me = MemberId::new(); let (id, op) = card("A");
    assert_eq!(ws.head(main).unwrap().seq, 0);
    assert_eq!(ws.record(main, me, 1, op.clone()).unwrap(), Moment { branch: main, seq: 1 });
    assert!(matches!(ws.record(main, me, 2, op), Err(WsError::Apply(ApplyError::AlreadyExists(_)))));
    assert_eq!(ws.head(main).unwrap().seq, 1);
    let c = &ws.branch(main).unwrap().changes()[0];
    assert_eq!((c.author, c.at, &c.origin), (me, 1, &Origin::Edit));
    assert!(ws.board_at(Moment { branch: main, seq: 0 }).unwrap().get(id).is_none());
}
#[test] fn a_fork_starts_from_its_parent_moment_and_then_diverges() {
    // main: create A (seq 1), set A.title "A2" (seq 2). fork "try-QEC" from main@1.
    // branch board: A.title == "A".  record on branch: set A.title "B".  main head board: still "A2".
    // record on main after the fork: create C.  branch head board: C absent.
    // branch.parent() == Some(main@1); branch.sync_points() == [SyncPoint { base: main@1, landed: None }]
}
#[test] fn a_fork_of_a_fork_replays_through_both_parents() { /* main: A.  b1 from main@1: + B.  b2 from b1@1: + C.  b2 head has A, B, C. */ }
#[test] fn branch_names_are_unique_and_non_empty() {
    // fork("main", ..) -> NameTaken; fork("  ", ..) -> EmptyName; fork from main@99 -> BadMoment
}
#[test] fn checkpoints_name_moments() {
    // checkpoint("before prof meeting", main@1) ok; same name again on main -> NameTaken; same name on another branch ok;
    // checkpoint at main@99 -> BadMoment; checkpoints(main) returns them ordered by seq
}
#[test] fn a_workspace_round_trips_through_json() { /* build two branches + a checkpoint; from_str(to_string(ws)) == ws */ }
```
Write each test out in full; the comments state the exact scenario and assertions.

- [ ] **Step 2: Run** `cargo test -p infall-core --test workspace` — Expected: FAIL to compile.
- [ ] **Step 3: Implement `workspace.rs`.** Keep a cached head `Board` per Branch (skipped by serde, rebuilt lazily or on deserialize) so `record` does not replay.
- [ ] **Step 4: Run** tests and clippy — Expected: all pass.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(core): workspace with branches, changes and checkpoints"`

---

### Task 5: Restore

**Files:**
- Modify: `crates/core/src/workspace.rs`
- Test: `crates/core/tests/restore.rs`

**Interfaces:**
- Consumes: `diff_ops`, `Workspace::append_batch`.
- Produces:
  ```rust
  impl Workspace {
      /// Appends the Changes that return `branch` to its Board at `to_seq`. Returns the new head.
      pub fn restore(&mut self, branch: BranchId, to_seq: u64, author: MemberId, at: i64) -> Result<Moment, WsError>;
  }
  ```
- All appended Changes carry `Origin::Restore { batch, to_seq }` with one shared `batch`. When nothing differs, nothing is appended and the current head is returned.

- [ ] **Step 1: Write the failing tests** in `crates/core/tests/restore.rs`:

```rust
#[test] fn restore_brings_back_the_earlier_board_without_erasing_history() {
    // main: create A, create B (seq 2) | set A.title "A2", delete B, create C (seq 5)
    // restore(main, 2): head board same_content board_at(main@2); head.seq > 5; first 5 changes unchanged;
    // C is deleted (tombstone), not absent; every new change has Origin::Restore { to_seq: 2, .. } with the same batch.
}
#[test] fn a_restore_can_itself_be_undone() {
    // continue from above: let before = 5; restore(main, 2); restore(main, before) -> head board same_content board_at(main@5)
}
#[test] fn restore_to_the_current_moment_records_nothing() { /* head unchanged, change count unchanged */ }
#[test] fn restore_past_the_end_is_refused() { /* restore(main, 99) == Err(WsError::BadMoment(main@99)); change count unchanged */ }
#[test] fn restore_on_a_fork_can_go_back_to_the_fork_moment() { /* branch with 3 changes; restore(branch, 0) same_content parent board at fork */ }
proptest::proptest! {
    #[test] fn restore_always_reaches_the_chosen_moment(seed in proptest::collection::vec(proptest::num::u8::ANY, 0..120), pick in 0usize..1000) {
        // scribble onto a scratch Board, record each accepted op on main; to = pick % (len + 1);
        // restore(main, to); head board same_content board_at(main@to)
    }
}
```

- [ ] **Step 2: Run** `cargo test -p infall-core --test restore` — Expected: FAIL to compile.
- [ ] **Step 3: Implement `restore`.**
- [ ] **Step 4: Run** tests and clippy — Expected: all pass.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(core): non-destructive restore"`

---

### Task 6: Three-way comparison and Conflicts

**Files:**
- Create: `crates/core/src/merge.rs`
- Modify: `crates/core/src/lib.rs`
- Test: `crates/core/tests/three_way.rs`

**Interfaces:**
- Consumes: `Board`, `Op`, `field_class`.
- Produces:
  ```rust
  pub enum Side { Source, Target }
  pub struct ConflictKey { pub entity: EntityId, pub field: Option<String> }   // None = edit vs delete; derives Ord
  pub enum Conflict {
      Field { entity: EntityId, field: String, base: Value, source: Value, target: Value },
      EditVsDelete { entity: EntityId, deleted_on: Side },
  }
  impl Conflict { pub fn key(&self) -> ConflictKey; }
  /// Automatic operations to apply to `target`, and the Conflicts a Member must decide.
  pub fn three_way(base: &Board, source: &Board, target: &Board) -> (Vec<Op>, Vec<Conflict>);
  ```
- Implements the two tables in spec §5 exactly. Automatic ops use the same group order as `diff_ops`. Conflicts are ordered by `key()`. An entity present on source and target but absent from base is compared as if the base held it deleted with no fields.

- [ ] **Step 1: Write the failing tests** in `crates/core/tests/three_way.rs`. Each builds `base`, clones it into `source` and `target`, edits them, and asserts on `three_way(&base, &source, &target)`:

```rust
#[test] fn same_title_changed_both_ways_is_a_field_conflict() {
    // base "Surface codes"; source "Surface & toric codes"; target "Surface codes (review)"
    // auto empty; conflicts == [Conflict::Field { entity, field: "title", base, source, target }] with those three texts
}
#[test] fn different_fields_of_one_card_both_survive() {
    // source sets summary "s"; target sets title "T" -> auto == [Set summary "s"]; no conflicts
}
#[test] fn both_sides_made_the_same_edit_is_nothing() { /* both set title "X" -> ([], []) */ }
#[test] fn layout_disagreement_follows_the_target() { /* source x=10, target x=99 -> ([], []) */ }
#[test] fn layout_moved_only_on_source_comes_across() { /* source x=10 -> auto == [Set x 10] */ }
#[test] fn a_card_new_on_source_is_created_with_its_fields() { /* "QEC thresholds" -> auto == [Create ..]; a card created then deleted on source -> auto == [Create, Delete] */ }
#[test] fn a_connection_to_a_card_created_and_deleted_on_source_still_merges() {
    // source: create Q, connect A->Q, Delete Q. Applying auto to target succeeds; Q is a tombstone; the connection is not visible.
}
#[test] fn a_card_absent_from_base_but_deleted_on_target_comes_back_from_source() {
    // base: empty. source: card Q title "new". target: card Q (same id) title "old", deleted.
    // auto == [Undelete Q, Set Q.title "new"]; no conflicts
}
#[test] fn a_card_new_on_target_is_left_alone() { /* ([], []) */ }
#[test] fn source_deleted_and_target_only_moved_it_is_deleted() {
    // "Grover search": source Delete; target sets x -> auto == [Delete]; no conflicts
}
#[test] fn source_deleted_but_target_edited_content_is_a_conflict() {
    // target sets title -> conflicts == [EditVsDelete { entity, deleted_on: Side::Source }]; auto has no Delete
}
#[test] fn target_deleted_but_source_edited_content_is_a_conflict() { /* deleted_on: Side::Target; auto empty */ }
#[test] fn target_deleted_and_source_untouched_stays_deleted() { /* ([], []) */ }
#[test] fn undeleted_on_source_comes_back_on_target() { /* base deleted; source Undelete + title "X" + x=5 -> auto == [Undelete, Set title "X", Set x 5] */ }
#[test] fn connection_to_a_card_the_target_deleted_still_merges() {
    // base: cards A, Z. source: connect A->Z. target: Delete Z.
    // auto == [Create connection]; applying auto to target succeeds; connection !is_visible; after Undelete Z it is visible.
}
proptest::proptest! {
    #[test] fn untouched_target_ends_up_equal_to_source(a in bytes(), b in bytes()) {
        // base = scribble(a); source = base + scribble(b); target = base.clone()
        // conflicts empty; apply auto to target (all ok); target.same_content(&source)
    }
    #[test] fn untouched_source_changes_nothing(a in bytes(), b in bytes()) {
        // source = base.clone(); target = base + scribble(b) -> ([], [])
    }
}
```

- [ ] **Step 2: Run** `cargo test -p infall-core --test three_way` — Expected: FAIL to compile.
- [ ] **Step 3: Implement `three_way`.**
- [ ] **Step 4: Run** tests and clippy — Expected: all pass.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(core): three-way comparison with conflicts"`

---

### Task 7: Planning, deciding, and applying a Merge

**Files:**
- Modify: `crates/core/src/merge.rs`, `crates/core/src/workspace.rs`
- Test: `crates/core/tests/merge.rs`

**Interfaces:**
- Consumes: `three_way`, `Conflict`, `ConflictKey`, `Side`, `Workspace::{board_at, head, append_batch}`, `SyncPoint`.
- Produces:
  ```rust
  pub enum Decision { TakeSource, TakeTarget, Custom(Value) }
  pub type Decisions = std::collections::BTreeMap<ConflictKey, Decision>;
  pub struct MergePlan { pub source: Moment, pub target: Moment, pub auto: Vec<Op>, pub conflicts: Vec<Conflict> }
  /// Operations for the decided Conflicts, to apply to `target` after the automatic ones.
  pub fn resolve(source: &Board, target: &Board, conflicts: &[Conflict], decisions: &Decisions) -> Result<Vec<Op>, MergeError>;
  impl Workspace {
      pub fn plan_merge(&self, source: BranchId, target: BranchId) -> Result<MergePlan, MergeError>;
      pub fn apply_merge(&mut self, plan: &MergePlan, decisions: &Decisions, author: MemberId, at: i64) -> Result<Moment, MergeError>;
  }
  pub enum MergeError { NotParentAndChild, Stale, Undecided(Vec<ConflictKey>), UnknownConflict(ConflictKey), CustomNotAllowed(ConflictKey), Ws(WsError) }
  ```
- `plan_merge`: `NotParentAndChild` unless one Branch's `parent().branch` is the other. Base = `board_at(last sync point's base)` of the child Branch. `source`/`target` in the plan are the two heads at planning time.
- `resolve`: `Undecided` lists every Conflict without a decision; a decision whose key matches no Conflict is `UnknownConflict`; `Custom` on an edit-vs-delete Conflict is `CustomNotAllowed`. Field: `TakeSource` → Set source's value, `TakeTarget` → nothing, `Custom(v)` → Set `v`. Edit vs delete: `TakeTarget` → nothing; `TakeSource` with `deleted_on: Source` → Delete; `TakeSource` with `deleted_on: Target` → Undelete, then Set every content field where source differs from target.
- `apply_merge`: `Stale` if either head differs from the plan's moments. Appends `plan.auto` then the resolved ops as one batch with `Origin::Merge { batch, source: plan.source }`; an invalid op makes the whole call fail with `Ws(..)` and appends nothing. On success, pushes `SyncPoint { base: plan.source, landed: Some(new target head) }` onto the child Branch. If there are no ops at all the sync point is still pushed with `landed: Some(current head)`.
- Change to `restore` (Task 5): after appending, remove from every Branch each sync point whose `landed` is on the restored Branch with `landed.seq > to_seq`.

- [ ] **Step 1: Write the failing tests** in `crates/core/tests/merge.rs`. Shared fixture `diverged()` returns `(ws, main, qec, ids)`: main has cards "Surface codes", "Grover search", "VQE notes"; fork `try-QEC` from main's head; then on main: title → "Surface codes (review)", Grover `x` → 300, VQE `summary` → "main summary"; on try-QEC: title → "Surface & toric codes", Delete Grover, VQE `color` → "blue", create "QEC thresholds".

```rust
#[test] fn the_review_lists_automatic_changes_and_conflicts() {
    // plan_merge(qec, main): conflicts == [Field title conflict on "Surface codes"];
    // auto contains exactly: Create "QEC thresholds", Set VQE.color "blue", Delete Grover
}
#[test] fn applying_needs_every_conflict_decided() {
    // apply_merge with empty decisions -> Err(Undecided([title key])); main change count unchanged
}
#[test] fn a_decided_merge_lands_as_one_batch() {
    // decide title -> Custom(text("Surface & toric codes (review)")); apply.
    // main head: that title; VQE summary "main summary" and color "blue"; Grover deleted; "QEC thresholds" live;
    // Grover x irrelevant. Every appended change has Origin::Merge { source: qec head at plan time, .. }, one shared batch.
    // try-QEC's own changes are untouched.
}
#[test] fn merging_again_straight_away_finds_nothing() { /* after the merge above: plan_merge(qec, main) -> auto empty, conflicts empty */ }
#[test] fn later_work_on_the_branch_merges_without_repeating_old_conflicts() {
    // after merging with TakeTarget on the title: qec sets "QEC thresholds".summary "new"; plan_merge(qec, main)
    // -> auto == [Set summary "new"], conflicts empty (the title is not raised again)
}
#[test] fn the_parent_can_be_merged_into_the_child() {
    // fresh diverged(): plan_merge(main, qec) -> title conflict with source/target swapped;
    // Grover: main only moved it, qec deleted it -> stays deleted, no conflict; auto == [Set VQE.summary "main summary"]
}
#[test] fn siblings_cannot_be_merged_directly() { /* two forks of main -> Err(NotParentAndChild); a branch with itself -> NotParentAndChild */ }
#[test] fn a_plan_goes_stale_when_the_target_moves() {            // Review Focus 1
    // plan; record a new card on main; apply -> Err(Stale); the new card is still there; nothing else appended.
    // same when the source moves.
}
#[test] fn an_undone_merge_can_be_merged_again() {                // Review Focus 2
    // let before = main head seq; plan + apply (TakeSource); restore(main, before);
    // plan_merge(qec, main) -> same conflicts as the very first plan, auto non-empty;
    // apply (TakeSource) -> "QEC thresholds" live on main again, Grover deleted, VQE color "blue"
}
#[test] fn an_invalid_hand_written_value_refuses_the_whole_merge() {   // Review Focus 3
    // decide title -> Custom(Value::Float(1.0)); apply -> Err(Ws(WsError::Apply(ApplyError::Schema(_))));
    // main change count unchanged; try-QEC sync points unchanged
}
#[test] fn decisions_must_match_the_conflicts() {
    // extra decision for an unrelated key -> UnknownConflict; Custom on an EditVsDelete -> CustomNotAllowed
}
#[test] fn edit_versus_delete_goes_whichever_way_is_decided() {
    // qec deletes "VQE notes" while main edited its summary -> EditVsDelete { deleted_on: Source }.
    //   TakeSource -> deleted on main.  TakeTarget -> still live with "main summary".
    // main deletes a card while qec retitled it -> EditVsDelete { deleted_on: Target }.
    //   TakeSource -> live on main with qec's title.  TakeTarget -> still deleted.
}
```

- [ ] **Step 2: Run** `cargo test -p infall-core --test merge` — Expected: FAIL to compile.
- [ ] **Step 3: Implement `resolve`, `plan_merge`, `apply_merge`, and the sync-point pruning in `restore`.**
- [ ] **Step 4: Run** `cargo test -p infall-core` and clippy — Expected: every test in all seven files passes, no warnings.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(core): plan, decide and apply merges"`

---

## Not in this plan

Each is its own plan, built on this crate: storage (SQLite) and the server with live updates; the Board UI; Pages, whose blocks become new entity kinds merged by these same rules; cherry-picking a single Card across Branches; Merges between Branches that are not parent and child.
