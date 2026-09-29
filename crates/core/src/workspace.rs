//! Branches, Changes and Checkpoints: the history of a Board.

use crate::board::{ApplyError, Board, Op};
use crate::diff::diff_ops;
use crate::ids::{BatchId, BranchId, ChangeId, MemberId};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
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
            },
            id,
        )
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

    /// The Board at `moment`: the parent's Board at the fork moment, then this Branch's first `seq` Changes.
    pub fn board_at(&self, moment: Moment) -> Result<Board, WsError> {
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

    /// Creates a Branch starting from the Board at `from`.
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
        if ops.is_empty() {
            return Ok(head);
        }
        let origin = Origin::Restore {
            batch: BatchId::new(),
            to_seq,
        };
        self.append_batch(branch, author, at, ops, origin)
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
        let mut board = self.board_at(head)?;
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
        self.head(branch)
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
}
