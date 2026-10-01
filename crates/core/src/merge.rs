//! Merges between a Branch and its parent: the three-way comparison that produces the
//! automatic operations and the Conflicts a Member must decide, and planning, deciding
//! and applying a Merge on a Workspace.

use crate::board::{Board, Entity, Op};
use crate::ids::{BatchId, BranchId, EntityId, MemberId};
use crate::schema::{EntityKind, FieldClass, Fields, Value, field_class};
use crate::workspace::{Branch, Moment, Origin, SyncPoint, Workspace, WsError};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;

/// One of the two Branches taking part in a Merge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Side {
    Source,
    Target,
}

/// Identifies what a Conflict is about: one field of an entity, or (`field: None`)
/// the entity itself in an edit vs delete Conflict.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct ConflictKey {
    pub entity: EntityId,
    pub field: Option<String>,
}

/// A disagreement between source and target that a Member must decide.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Conflict {
    /// Both sides changed the same Content field to different values.
    Field {
        entity: EntityId,
        field: String,
        base: Value,
        source: Value,
        target: Value,
    },
    /// One side deleted the entity while the other changed one of its Content fields.
    EditVsDelete { entity: EntityId, deleted_on: Side },
}

impl Conflict {
    pub fn key(&self) -> ConflictKey {
        match self {
            Conflict::Field { entity, field, .. } => ConflictKey {
                entity: *entity,
                field: Some(field.clone()),
            },
            Conflict::EditVsDelete { entity, .. } => ConflictKey {
                entity: *entity,
                field: None,
            },
        }
    }
}

/// How a Member decided one Conflict.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Decision {
    TakeSource,
    TakeTarget,
    /// A hand-written value; only for field Conflicts.
    Custom(Value),
}

/// One Decision per Conflict, ordered by key.
///
/// Serialized as a list of `[ConflictKey, Decision]` pairs, because JSON object keys must
/// be strings; a list that names the same Conflict twice is rejected.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(
    try_from = "Vec<(ConflictKey, Decision)>",
    into = "Vec<(ConflictKey, Decision)>"
)]
pub struct Decisions(BTreeMap<ConflictKey, Decision>);

impl Decisions {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records `decision` for `key`, returning the Decision it replaces.
    pub fn insert(&mut self, key: ConflictKey, decision: Decision) -> Option<Decision> {
        self.0.insert(key, decision)
    }

    pub fn get(&self, key: &ConflictKey) -> Option<&Decision> {
        self.0.get(key)
    }

    /// Decisions in key order.
    pub fn iter(&self) -> impl Iterator<Item = (&ConflictKey, &Decision)> {
        self.0.iter()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }
}

impl FromIterator<(ConflictKey, Decision)> for Decisions {
    fn from_iter<I: IntoIterator<Item = (ConflictKey, Decision)>>(iter: I) -> Self {
        Decisions(iter.into_iter().collect())
    }
}

/// Why a serialized list of Decisions was rejected.
#[derive(Debug, Clone, PartialEq, Error, Serialize, Deserialize)]
#[error("more than one decision for {0:?}")]
pub struct RepeatedDecision(pub ConflictKey);

impl TryFrom<Vec<(ConflictKey, Decision)>> for Decisions {
    type Error = RepeatedDecision;

    fn try_from(list: Vec<(ConflictKey, Decision)>) -> Result<Self, Self::Error> {
        let mut decisions = Decisions::new();
        for (key, decision) in list {
            if decisions.0.contains_key(&key) {
                return Err(RepeatedDecision(key));
            }
            decisions.0.insert(key, decision);
        }
        Ok(decisions)
    }
}

impl From<Decisions> for Vec<(ConflictKey, Decision)> {
    fn from(decisions: Decisions) -> Self {
        decisions.0.into_iter().collect()
    }
}

/// A Merge as reviewed: the heads and base it was planned against, what happens
/// automatically, and what a Member must decide.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MergePlan {
    pub source: Moment,
    pub target: Moment,
    /// The moment whose Board the comparison used as the base.
    pub base: Moment,
    pub auto: Vec<Op>,
    pub conflicts: Vec<Conflict>,
}

/// Why a Merge could not be planned or applied.
#[derive(Debug, Clone, PartialEq, Error, Serialize, Deserialize)]
pub enum MergeError {
    #[error("a merge is only allowed between a branch and its direct parent")]
    NotParentAndChild,
    #[error("a branch has changed since the merge was planned; plan it again")]
    Stale,
    #[error("conflicts without a decision: {0:?}")]
    Undecided(Vec<ConflictKey>),
    #[error("a decision matches no conflict: {0:?}")]
    UnknownConflict(ConflictKey),
    #[error("a hand-written value is not allowed for edit vs delete: {0:?}")]
    CustomNotAllowed(ConflictKey),
    #[error(transparent)]
    Ws(#[from] WsError),
}

/// Operations for the decided Conflicts, to apply to `target` after the automatic ones.
pub fn resolve(
    source: &Board,
    target: &Board,
    conflicts: &[Conflict],
    decisions: &Decisions,
) -> Result<Vec<Op>, MergeError> {
    let keys: BTreeSet<ConflictKey> = conflicts.iter().map(Conflict::key).collect();
    if let Some((key, _)) = decisions.iter().find(|(k, _)| !keys.contains(*k)) {
        return Err(MergeError::UnknownConflict(key.clone()));
    }
    let mut decided = Vec::new();
    let mut undecided = Vec::new();
    for conflict in conflicts {
        match decisions.get(&conflict.key()) {
            Some(decision) => decided.push((conflict, decision)),
            None => undecided.push(conflict.key()),
        }
    }
    if !undecided.is_empty() {
        return Err(MergeError::Undecided(undecided));
    }

    let mut ops = Vec::new();
    for (conflict, decision) in decided {
        match (conflict, decision) {
            (_, Decision::TakeTarget) => {}
            (
                Conflict::Field {
                    entity,
                    field,
                    source: value,
                    ..
                },
                Decision::TakeSource,
            )
            | (Conflict::Field { entity, field, .. }, Decision::Custom(value)) => {
                ops.push(set(*entity, field, value));
            }
            (Conflict::EditVsDelete { .. }, Decision::Custom(_)) => {
                return Err(MergeError::CustomNotAllowed(conflict.key()));
            }
            (
                Conflict::EditVsDelete {
                    entity,
                    deleted_on: Side::Source,
                },
                Decision::TakeSource,
            ) => ops.push(Op::Delete { entity: *entity }),
            (
                Conflict::EditVsDelete {
                    entity,
                    deleted_on: Side::Target,
                },
                Decision::TakeSource,
            ) => {
                ops.push(Op::Undelete { entity: *entity });
                if let (Some(s), Some(t)) = (source.get(*entity), target.get(*entity)) {
                    for name in field_names(&s.fields, &t.fields) {
                        if !is_layout(s.kind, name) && s.get(name) != t.get(name) {
                            ops.push(set(*entity, name, s.get(name)));
                        }
                    }
                }
            }
        }
    }
    Ok(ops)
}

impl Workspace {
    /// Compares `source` and `target` against the most recent moment contained in both.
    pub fn plan_merge(&self, source: BranchId, target: BranchId) -> Result<MergePlan, MergeError> {
        let base = self.merge_base(source, target)?;
        let (source, target) = (self.head(source)?, self.head(target)?);
        let (auto, conflicts) = three_way(
            &self.board_at(base)?,
            &self.board_at(source)?,
            &self.board_at(target)?,
        );
        Ok(MergePlan {
            source,
            target,
            base,
            auto,
            conflicts,
        })
    }

    /// Applies a planned Merge as one batch on the target and records where the two
    /// Branches now meet. Returns the target's new head.
    ///
    /// With `checkpoint: Some(name)`, a Checkpoint of that name is placed on the target at
    /// its head just before the Merge's Changes. An empty or already used name refuses the
    /// Merge; nothing is changed on any failure.
    pub fn apply_merge(
        &mut self,
        plan: &MergePlan,
        decisions: &Decisions,
        author: MemberId,
        at: i64,
        checkpoint: Option<&str>,
    ) -> Result<Moment, MergeError> {
        let child = self
            .child_of_pair(plan.source.branch, plan.target.branch)?
            .id();
        if self.head(plan.source.branch)? != plan.source
            || self.head(plan.target.branch)? != plan.target
            || self.merge_base(plan.source.branch, plan.target.branch)? != plan.base
        {
            return Err(MergeError::Stale);
        }
        // The plan may have travelled through a client: apply only what the Branches give now.
        let source = self.board_at(plan.source)?;
        let target = self.board_at(plan.target)?;
        let (auto, conflicts) = three_way(&self.board_at(plan.base)?, &source, &target);
        if auto != plan.auto || conflicts != plan.conflicts {
            return Err(MergeError::Stale);
        }
        let decided = resolve(&source, &target, &conflicts, decisions)?;
        let ops = [auto, decided].concat();
        // Everything that can be refused is checked before anything is changed.
        let checkpoint = checkpoint
            .map(|name| self.checkpoint_name(plan.target.branch, name))
            .transpose()?;
        let landed = if ops.is_empty() {
            plan.target
        } else {
            let origin = Origin::Merge {
                batch: BatchId::new(),
                source: plan.source,
            };
            self.append_batch(plan.target.branch, author, at, ops, origin)?
        };
        if let Some(name) = checkpoint {
            self.push_checkpoint(name, plan.target, author, at);
        }
        self.push_sync_point(
            child,
            SyncPoint {
                base: plan.source,
                landed: Some(landed),
            },
        );
        Ok(landed)
    }

    /// The moment whose Board is the base for merging between `a` and `b`: the source
    /// moment of the most recent remembered Merge between them, or the fork moment.
    fn merge_base(&self, a: BranchId, b: BranchId) -> Result<Moment, MergeError> {
        let child = self.child_of_pair(a, b)?;
        child
            .sync_points()
            .last()
            .map(|point| point.base)
            // Unreachable for Workspaces built through this API (`fork` seeds a sync point
            // and Restore never removes it), but reachable from a deserialized Workspace with
            // an empty sync list, where the fork moment is the right base.
            .or(child.parent())
            .ok_or(MergeError::NotParentAndChild)
    }

    /// Of two Branches, the one whose parent is the other.
    fn child_of_pair(&self, a: BranchId, b: BranchId) -> Result<&Branch, MergeError> {
        let branch_a = self.branch(a).ok_or(WsError::UnknownBranch(a))?;
        let branch_b = self.branch(b).ok_or(WsError::UnknownBranch(b))?;
        if branch_a.parent().map(|m| m.branch) == Some(b) {
            Ok(branch_a)
        } else if branch_b.parent().map(|m| m.branch) == Some(a) {
            Ok(branch_b)
        } else {
            Err(MergeError::NotParentAndChild)
        }
    }
}

static NO_FIELDS: Fields = Fields::new();

/// Automatic operations to apply to `target`, and the Conflicts a Member must decide.
///
/// Operations are ordered like `diff_ops`: Creates of Cards and Frames, Creates of
/// Connections, Undeletes, Sets, Deletes; within each group by entity id, then field name.
/// Conflicts are ordered by `key()`. An entity present on both sides but absent from
/// `base` is compared as if `base` held it deleted with no fields.
pub fn three_way(base: &Board, source: &Board, target: &Board) -> (Vec<Op>, Vec<Conflict>) {
    let mut creates = Vec::new();
    let mut link_creates = Vec::new();
    let mut undeletes = Vec::new();
    let mut sets = Vec::new();
    let mut deletes = Vec::new();
    let mut conflicts = Vec::new();

    for (id, s) in source.entities() {
        let Some(t) = target.get(id) else {
            // Only on source: create with source's fields, then delete if source has it deleted.
            let create = Op::Create {
                entity: id,
                kind: s.kind,
                fields: s.fields.clone(),
            };
            if s.kind == EntityKind::Connection {
                link_creates.push(create);
            } else {
                creates.push(create);
            }
            if s.deleted {
                deletes.push(Op::Delete { entity: id });
            }
            continue;
        };
        let (base_deleted, base_fields) = match base.get(id) {
            Some(b) => (b.deleted, &b.fields),
            None => (true, &NO_FIELDS),
        };

        match (s.deleted, t.deleted) {
            (true, true) => {}
            (false, false) => {
                compare_fields(id, s.kind, base_fields, s, t, &mut sets, &mut conflicts);
            }
            (true, false) => {
                // b deleted, t live, s deleted: nothing.
                if !base_deleted {
                    if content_changed(s.kind, base_fields, &t.fields) {
                        conflicts.push(Conflict::EditVsDelete {
                            entity: id,
                            deleted_on: Side::Source,
                        });
                    } else {
                        deletes.push(Op::Delete { entity: id });
                    }
                }
            }
            (false, true) => {
                if base_deleted {
                    undeletes.push(Op::Undelete { entity: id });
                    for name in field_names(&s.fields, &t.fields) {
                        if s.get(name) != t.get(name) {
                            sets.push(set(id, name, s.get(name)));
                        }
                    }
                } else if content_changed(s.kind, base_fields, &s.fields) {
                    conflicts.push(Conflict::EditVsDelete {
                        entity: id,
                        deleted_on: Side::Target,
                    });
                }
                // Otherwise it stays deleted.
            }
        }
    }

    conflicts.sort_by_cached_key(Conflict::key);
    (
        [creates, link_creates, undeletes, sets, deletes].concat(),
        conflicts,
    )
}

/// The per-field table for an entity live on both sides.
fn compare_fields(
    id: EntityId,
    kind: EntityKind,
    base: &Fields,
    s: &Entity,
    t: &Entity,
    sets: &mut Vec<Op>,
    conflicts: &mut Vec<Conflict>,
) {
    let names: BTreeSet<&String> = base
        .keys()
        .chain(s.fields.keys())
        .chain(t.fields.keys())
        .collect();
    for name in names {
        let b = base.get(name).unwrap_or(&Value::Null);
        let (sv, tv) = (s.get(name), t.get(name));
        if sv == b || sv == tv {
            continue;
        }
        if tv == b {
            sets.push(set(id, name, sv));
        } else if !is_layout(kind, name) {
            conflicts.push(Conflict::Field {
                entity: id,
                field: name.clone(),
                base: b.clone(),
                source: sv.clone(),
                target: tv.clone(),
            });
        }
        // A layout field changed to different values on both sides: target wins.
    }
}

/// Whether any Content field differs between `base` and `side`.
fn content_changed(kind: EntityKind, base: &Fields, side: &Fields) -> bool {
    field_names(base, side).into_iter().any(|name| {
        !is_layout(kind, name)
            && base.get(name).unwrap_or(&Value::Null) != side.get(name).unwrap_or(&Value::Null)
    })
}

/// Unknown fields are treated as Content, so they never silently lose to the target.
fn is_layout(kind: EntityKind, field: &str) -> bool {
    field_class(kind, field) == Some(FieldClass::Layout)
}

fn field_names<'a>(a: &'a Fields, b: &'a Fields) -> BTreeSet<&'a String> {
    a.keys().chain(b.keys()).collect()
}

fn set(entity: EntityId, field: &str, value: &Value) -> Op {
    Op::Set {
        entity,
        field: field.to_string(),
        value: value.clone(),
    }
}
