//! Branches, Changes and Checkpoints: the history of a Board.

use crate::board::{ApplyError, Board, Op};
use crate::diff::diff_ops;
use crate::ids::{BatchId, BranchId, ChangeId, MemberId};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, MutexGuard};
use thiserror::Error;

/// A point in a Branch's history: how many of its own Changes have been applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Moment {
    pub branch: BranchId,
    pub seq: u64,
}

/// Why a Change was recorded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Origin {
    Edit,
    Restore { batch: BatchId, to_seq: u64 },
    Merge { batch: BatchId, source: Moment },
}

/// One recorded edit on a Branch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Change {
    pub id: ChangeId,
    pub author: MemberId,
    pub at: i64,
    pub op: Op,
    pub origin: Origin,
}

/// A name attached to a moment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Checkpoint {
    pub name: String,
    pub moment: Moment,
    pub author: MemberId,
    pub at: i64,
}

/// A moment known to be contained in both a Branch and its parent (or child).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncPoint {
    pub base: Moment,
    pub landed: Option<Moment>,
}

/// A line of Changes, forked from a parent moment (except `main`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Branch {
    id: BranchId,
    name: String,
    parent: Option<Moment>,
    created_by: Option<MemberId>,
    created_at: Option<i64>,
    changes: Vec<Change>,
    sync_points: Vec<SyncPoint>,
    checkpoints: Vec<Checkpoint>,
}

impl Branch {
    pub fn id(&self) -> BranchId {
        self.id
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// The moment this Branch was forked from; `None` only for main.
    pub fn parent(&self) -> Option<Moment> {
        self.parent
    }

    /// Who forked this Branch; `None` for main.
    pub fn created_by(&self) -> Option<MemberId> {
        self.created_by
    }

    /// When this Branch was forked; `None` for main.
    pub fn created_at(&self) -> Option<i64> {
        self.created_at
    }

    pub fn changes(&self) -> &[Change] {
        &self.changes
    }

    pub fn sync_points(&self) -> &[SyncPoint] {
        &self.sync_points
    }

    /// The Checkpoints in the order they were made (`Workspace::checkpoints` sorts them).
    pub fn recorded_checkpoints(&self) -> &[Checkpoint] {
        &self.checkpoints
    }
}

/// Everything a Branch is made of, for a store that keeps the parts apart: a Branch is
/// put back together from these with `Workspace::from_parts`, and taken apart again with
/// the `Branch` getters.
#[derive(Debug, Clone, PartialEq)]
pub struct BranchParts {
    pub id: BranchId,
    pub name: String,
    pub parent: Option<Moment>,
    pub created_by: Option<MemberId>,
    pub created_at: Option<i64>,
    pub changes: Vec<Change>,
    pub sync_points: Vec<SyncPoint>,
    /// In the order they were made.
    pub checkpoints: Vec<Checkpoint>,
}

/// Why a Workspace call was rejected.
#[derive(Debug, Clone, PartialEq, Error, Serialize, Deserialize)]
pub enum WsError {
    #[error("unknown branch {0:?}")]
    UnknownBranch(BranchId),
    #[error("no such moment {0:?}")]
    BadMoment(Moment),
    #[error("name {0:?} is already taken")]
    NameTaken(String),
    #[error("name must not be empty")]
    EmptyName,
    #[error(transparent)]
    Apply(#[from] ApplyError),
}

/// All Branches of a research board.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Workspace {
    branches: BTreeMap<BranchId, Branch>,
    /// The Board at the head of each Branch, once worked out (docs/specs/scale.md). Only a
    /// shortcut: never stored, never compared, and always the same as replaying the Changes.
    #[serde(skip)]
    heads: Heads,
}

/// Head Boards already worked out, by Branch, each with the `seq` it is the Board at.
///
/// Changes are only ever appended, so an entry whose `seq` is the Branch's head is right;
/// any other is ignored. A clone of the Workspace shares the Boards until either side
/// records on that Branch.
#[derive(Default)]
struct Heads(Mutex<HashMap<BranchId, (u64, Arc<Board>)>>);

impl Heads {
    fn lock(&self) -> MutexGuard<'_, HashMap<BranchId, (u64, Arc<Board>)>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn get(&self, at: Moment) -> Option<Arc<Board>> {
        self.lock()
            .get(&at.branch)
            .filter(|(seq, _)| *seq == at.seq)
            .map(|(_, board)| board.clone())
    }

    fn take(&self, at: Moment) -> Option<Arc<Board>> {
        let mut map = self.lock();
        match map.get(&at.branch) {
            Some((seq, _)) if *seq == at.seq => map.remove(&at.branch).map(|(_, b)| b),
            _ => None,
        }
    }

    fn put(&self, at: Moment, board: Arc<Board>) {
        self.lock().insert(at.branch, (at.seq, board));
    }
}

impl Clone for Heads {
    fn clone(&self) -> Heads {
        Heads(Mutex::new(self.lock().clone()))
    }
}

impl PartialEq for Heads {
    fn eq(&self, _: &Heads) -> bool {
        true
    }
}

impl std::fmt::Debug for Heads {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Heads")
    }
}

impl Workspace {
    /// A Workspace holding one empty Branch named `main`.
    pub fn new() -> (Workspace, BranchId) {
        let id = BranchId::new();
        let main = Branch {
            id,
            name: "main".to_string(),
            parent: None,
            created_by: None,
            created_at: None,
            changes: Vec::new(),
            sync_points: Vec::new(),
            checkpoints: Vec::new(),
        };
        (
            Workspace {
                branches: BTreeMap::from([(id, main)]),
                heads: Heads::default(),
            },
            id,
        )
    }

    /// The Workspace made of these Branches, exactly as stored: nothing is checked or
    /// worked out (the same as reading one back from its JSON). A later Branch with the
    /// same id replaces an earlier one.
    pub fn from_parts(branches: impl IntoIterator<Item = BranchParts>) -> Workspace {
        Workspace {
            branches: branches
                .into_iter()
                .map(|p| {
                    let branch = Branch {
                        id: p.id,
                        name: p.name,
                        parent: p.parent,
                        created_by: p.created_by,
                        created_at: p.created_at,
                        changes: p.changes,
                        sync_points: p.sync_points,
                        checkpoints: p.checkpoints,
                    };
                    (p.id, branch)
                })
                .collect(),
            heads: Heads::default(),
        }
    }

    pub fn branch(&self, id: BranchId) -> Option<&Branch> {
        self.branches.get(&id)
    }

    pub fn branch_by_name(&self, name: &str) -> Option<&Branch> {
        self.branches.values().find(|b| b.name == name)
    }

    /// Branches in id order.
    pub fn branches(&self) -> impl Iterator<Item = &Branch> {
        self.branches.values()
    }

    /// The moment after all of the Branch's Changes.
    pub fn head(&self, branch: BranchId) -> Result<Moment, WsError> {
        let b = self
            .branches
            .get(&branch)
            .ok_or(WsError::UnknownBranch(branch))?;
        Ok(Moment {
            branch,
            seq: b.changes.len() as u64,
        })
    }

    /// The Board at the head of `branch`, shared: worked out once per head, not per call.
    pub fn head_board(&self, branch: BranchId) -> Result<Arc<Board>, WsError> {
        let head = self.head(branch)?;
        if let Some(board) = self.heads.get(head) {
            return Ok(board);
        }
        let board = Arc::new(self.replay(head)?);
        self.heads.put(head, board.clone());
        Ok(board)
    }

    /// The Board at `moment`: the parent's Board at the fork moment, then this Branch's first `seq` Changes.
    pub fn board_at(&self, moment: Moment) -> Result<Board, WsError> {
        if let Some(board) = self.heads.get(moment) {
            return Ok(Board::clone(&board));
        }
        self.replay(moment)
    }

    fn replay(&self, moment: Moment) -> Result<Board, WsError> {
        let b = self
            .branches
            .get(&moment.branch)
            .ok_or(WsError::UnknownBranch(moment.branch))?;
        let seq = usize::try_from(moment.seq).map_err(|_| WsError::BadMoment(moment))?;
        let changes = b.changes.get(..seq).ok_or(WsError::BadMoment(moment))?;
        let mut board = match b.parent {
            Some(parent) => self.board_at(parent)?,
            None => Board::new(),
        };
        for change in changes {
            board.apply(&change.op)?;
        }
        Ok(board)
    }

    /// Records `op` as an edit at the head of `branch`; a rejected op records nothing.
    pub fn record(
        &mut self,
        branch: BranchId,
        author: MemberId,
        at: i64,
        op: Op,
    ) -> Result<Moment, WsError> {
        self.append_batch(branch, author, at, vec![op], Origin::Edit)
    }

    /// Records `ops` as one all-or-nothing batch of edits at the head of `branch`. Returns the
    /// new head. If any op is rejected, nothing is recorded; an empty `ops` records nothing
    /// and returns the current head.
    pub fn record_all(
        &mut self,
        branch: BranchId,
        author: MemberId,
        at: i64,
        ops: Vec<Op>,
    ) -> Result<Moment, WsError> {
        if ops.is_empty() {
            return self.head(branch);
        }
        self.append_batch(branch, author, at, ops, Origin::Edit)
    }

    /// Creates a Branch starting from the Board at `from`.
    ///
    /// The name is trimmed before the empty and uniqueness checks, and stored trimmed.
    pub fn fork(
        &mut self,
        name: &str,
        from: Moment,
        author: MemberId,
        at: i64,
    ) -> Result<BranchId, WsError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(WsError::EmptyName);
        }
        if self.branch_by_name(name).is_some() {
            return Err(WsError::NameTaken(name.to_string()));
        }
        self.board_at(from)?;
        let id = BranchId::new();
        self.branches.insert(
            id,
            Branch {
                id,
                name: name.to_string(),
                parent: Some(from),
                created_by: Some(author),
                created_at: Some(at),
                changes: Vec::new(),
                sync_points: vec![SyncPoint {
                    base: from,
                    landed: None,
                }],
                checkpoints: Vec::new(),
            },
        );
        Ok(id)
    }

    /// Names `moment`; names are unique within its Branch.
    ///
    /// The name is trimmed before the empty and uniqueness checks, and stored trimmed.
    pub fn checkpoint(
        &mut self,
        name: &str,
        moment: Moment,
        author: MemberId,
        at: i64,
    ) -> Result<(), WsError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(WsError::EmptyName);
        }
        let b = self
            .branches
            .get(&moment.branch)
            .ok_or(WsError::UnknownBranch(moment.branch))?;
        if moment.seq > b.changes.len() as u64 {
            return Err(WsError::BadMoment(moment));
        }
        if b.checkpoints.iter().any(|c| c.name == name) {
            return Err(WsError::NameTaken(name.to_string()));
        }
        if let Some(b) = self.branches.get_mut(&moment.branch) {
            b.checkpoints.push(Checkpoint {
                name: name.to_string(),
                moment,
                author,
                at,
            });
        }
        Ok(())
    }

    /// Trims `name` and checks it could be given to a Checkpoint on `branch`:
    /// not empty and not already used there. Changes nothing.
    pub(crate) fn checkpoint_name(&self, branch: BranchId, name: &str) -> Result<String, WsError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(WsError::EmptyName);
        }
        let b = self
            .branches
            .get(&branch)
            .ok_or(WsError::UnknownBranch(branch))?;
        if b.checkpoints.iter().any(|c| c.name == name) {
            return Err(WsError::NameTaken(name.to_string()));
        }
        Ok(name.to_string())
    }

    /// Adds a Checkpoint whose `name` has passed `checkpoint_name` for `moment.branch`.
    pub(crate) fn push_checkpoint(
        &mut self,
        name: String,
        moment: Moment,
        author: MemberId,
        at: i64,
    ) {
        if let Some(b) = self.branches.get_mut(&moment.branch) {
            b.checkpoints.push(Checkpoint {
                name,
                moment,
                author,
                at,
            });
        }
    }

    /// The Branch's Checkpoints ordered by moment, then name.
    pub fn checkpoints(&self, branch: BranchId) -> Vec<&Checkpoint> {
        let mut list: Vec<&Checkpoint> = self
            .branches
            .get(&branch)
            .map(|b| b.checkpoints.iter().collect())
            .unwrap_or_default();
        list.sort_by(|a, b| (a.moment.seq, &a.name).cmp(&(b.moment.seq, &b.name)));
        list
    }

    /// Appends the Changes that return `branch` to its Board at `to_seq`. Returns the new head.
    ///
    /// Entities created after `to_seq` become deleted and keep the field values they had
    /// at the head.
    ///
    /// A Merge that landed on `branch` after `to_seq` is undone by this, so it is forgotten,
    /// together with every later Merge between the same two Branches: merging the same
    /// source again brings its work back.
    pub fn restore(
        &mut self,
        branch: BranchId,
        to_seq: u64,
        author: MemberId,
        at: i64,
    ) -> Result<Moment, WsError> {
        let head = self.head(branch)?;
        let target = self.board_at(Moment {
            branch,
            seq: to_seq,
        })?;
        let ops = diff_ops(&self.board_at(head)?, &target);
        let head = if ops.is_empty() {
            head
        } else {
            let origin = Origin::Restore {
                batch: BatchId::new(),
                to_seq,
            };
            self.append_batch(branch, author, at, ops, origin)?
        };
        // Each Branch's sync points form a chain, each Merge computed on top of the one
        // before: forgetting one forgets every later one too. The fork point never lands.
        for b in self.branches.values_mut() {
            let undone = b.sync_points.iter().position(|sp| {
                sp.landed
                    .is_some_and(|landed| landed.branch == branch && landed.seq > to_seq)
            });
            if let Some(first) = undone {
                b.sync_points.truncate(first);
            }
        }
        Ok(head)
    }

    /// Records that `point.base` is now contained in both `child` and its parent.
    pub(crate) fn push_sync_point(&mut self, child: BranchId, point: SyncPoint) {
        if let Some(b) = self.branches.get_mut(&child) {
            b.sync_points.push(point);
        }
    }

    /// Appends `ops` to `branch` as Changes with `origin`; if any op is rejected, nothing is appended.
    pub(crate) fn append_batch(
        &mut self,
        branch: BranchId,
        author: MemberId,
        at: i64,
        ops: Vec<Op>,
        origin: Origin,
    ) -> Result<Moment, WsError> {
        let head = self.head(branch)?;
        // The head Board is taken out while the ops are tried on it: if one is refused, the
        // half-changed Board is dropped and worked out again when next asked for.
        let mut board = match self.heads.take(head) {
            Some(board) => Arc::try_unwrap(board).unwrap_or_else(|shared| Board::clone(&shared)),
            None => self.replay(head)?,
        };
        for op in &ops {
            board.apply(op)?;
        }
        if let Some(b) = self.branches.get_mut(&branch) {
            b.changes.extend(ops.into_iter().map(|op| Change {
                id: ChangeId::new(),
                author,
                at,
                op,
                origin: origin.clone(),
            }));
        }
        let head = self.head(branch)?;
        self.heads.put(head, Arc::new(board));
        Ok(head)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{EntityKind, Fields, Value};

    fn create(id: crate::ids::EntityId) -> Op {
        let mut fields = Fields::new();
        fields.insert("title".to_string(), Value::Text("t".to_string()));
        Op::Create {
            entity: id,
            kind: EntityKind::Card,
            fields,
        }
    }

    #[test]
    fn a_batch_is_all_or_nothing_and_stamps_every_change_with_its_origin() {
        let (mut ws, main) = Workspace::new();
        let me = MemberId::new();
        let (a, b) = (crate::ids::EntityId::new(), crate::ids::EntityId::new());
        let origin = Origin::Restore {
            batch: BatchId::new(),
            to_seq: 0,
        };
        let head = ws
            .append_batch(main, me, 1, vec![create(a), create(b)], origin.clone())
            .unwrap();
        assert_eq!(head.seq, 2);
        assert!(
            ws.branch(main)
                .unwrap()
                .changes()
                .iter()
                .all(|c| c.origin == origin)
        );

        let before = ws.clone();
        let board_before = ws.board_at(ws.head(main).unwrap()).unwrap();
        let c = crate::ids::EntityId::new();
        let bad = ws.append_batch(main, me, 2, vec![create(c), create(a)], Origin::Edit);
        assert!(matches!(
            bad,
            Err(WsError::Apply(ApplyError::AlreadyExists(_)))
        ));
        assert_eq!(ws, before);
        assert_eq!(ws.board_at(ws.head(main).unwrap()).unwrap(), board_before);
    }

    #[test]
    fn a_workspace_taken_apart_and_put_back_together_is_the_same() {
        let (mut ws, main) = Workspace::new();
        let me = MemberId::new();
        let a = crate::ids::EntityId::new();
        ws.record(main, me, 1, create(a)).unwrap();
        ws.checkpoint("zz later name", ws.head(main).unwrap(), me, 2)
            .unwrap();
        ws.checkpoint(
            "aa",
            Moment {
                branch: main,
                seq: 0,
            },
            me,
            3,
        )
        .unwrap();
        let side = ws.fork("side", ws.head(main).unwrap(), me, 4).unwrap();
        ws.record(side, me, 5, Op::Delete { entity: a }).unwrap();
        let parts: Vec<BranchParts> = ws
            .branches()
            .map(|b| BranchParts {
                id: b.id(),
                name: b.name().to_string(),
                parent: b.parent(),
                created_by: b.created_by(),
                created_at: b.created_at(),
                changes: b.changes().to_vec(),
                sync_points: b.sync_points().to_vec(),
                checkpoints: b.recorded_checkpoints().to_vec(),
            })
            .collect();
        // In the order made, not sorted.
        let names: Vec<&str> = parts
            .iter()
            .find(|p| p.id == main)
            .unwrap()
            .checkpoints
            .iter()
            .map(|c| c.name.as_str())
            .collect();
        assert_eq!(names, ["zz later name", "aa"]);
        let back = Workspace::from_parts(parts);
        assert_eq!(back, ws);
        assert_eq!(
            serde_json::to_string(&back).unwrap(),
            serde_json::to_string(&ws).unwrap()
        );
        assert_eq!(
            *back.head_board(side).unwrap(),
            *ws.head_board(side).unwrap()
        );
    }

    #[test]
    fn the_remembered_head_board_is_always_the_replayed_one() {
        let (mut ws, main) = Workspace::new();
        let me = MemberId::new();
        let mut ids = Vec::new();
        for i in 0..30u32 {
            let id = crate::ids::EntityId::new();
            ids.push(id);
            ws.record(main, me, i64::from(i), create(id)).unwrap();
            if i % 3 == 0 {
                // A clone records on its own; the original keeps what it had.
                let before = ws.head_board(main).unwrap();
                let mut copy = ws.clone();
                copy.record(main, me, 0, create(crate::ids::EntityId::new()))
                    .unwrap();
                assert_eq!(*ws.head_board(main).unwrap(), *before);
                assert_eq!(
                    *copy.head_board(main).unwrap(),
                    copy.replay(copy.head(main).unwrap()).unwrap()
                );
            }
            if i % 5 == 0 {
                // A refused batch leaves the head as it was.
                let refused = ws.record_all(main, me, 0, vec![create(ids[0])]);
                assert!(refused.is_err());
            }
            let head = ws.head(main).unwrap();
            assert_eq!(*ws.head_board(main).unwrap(), ws.replay(head).unwrap());
            assert_eq!(ws.board_at(head).unwrap(), ws.replay(head).unwrap());
        }
        let fork = ws.head(main).unwrap();
        let side = ws.fork("side", fork, me, 99).unwrap();
        ws.record(side, me, 100, Op::Delete { entity: ids[1] })
            .unwrap();
        ws.record(main, me, 101, create(crate::ids::EntityId::new()))
            .unwrap();
        for branch in [main, side] {
            let head = ws.head(branch).unwrap();
            assert_eq!(*ws.head_board(branch).unwrap(), ws.replay(head).unwrap());
        }
        // What is remembered is never stored.
        let json = serde_json::to_string(&ws).unwrap();
        let back: Workspace = serde_json::from_str(&json).unwrap();
        assert_eq!(back, ws);
        assert_eq!(serde_json::to_string(&back).unwrap(), json);
    }
}
