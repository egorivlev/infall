//! Three-way comparison of two Boards against their base, producing the automatic
//! operations of a Merge and the Conflicts a Member must decide.

use crate::board::{Board, Entity, Op};
use crate::ids::EntityId;
use crate::schema::{EntityKind, FieldClass, Fields, Value, field_class};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

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
