//! The operations that turn one Board into another.

use crate::board::{Board, Entity, Op};
use crate::ids::EntityId;
use crate::schema::EntityKind;
use std::collections::BTreeSet;

/// Operations that, applied in order to `from`, give a Board with the same content as `to`.
///
/// Order: Creates of Cards and Frames, Creates of Connections, Undeletes, Sets, Deletes;
/// within each group by entity id, then field name. An entity that is deleted in `to` and
/// absent from `from` is Created and then Deleted. Fields are compared only for entities
/// live in `to`.
pub fn diff_ops(from: &Board, to: &Board) -> Vec<Op> {
    let mut creates = Vec::new();
    let mut link_creates = Vec::new();
    let mut undeletes = Vec::new();
    let mut sets = Vec::new();
    let mut deletes: Vec<EntityId> = Vec::new();

    for (id, target) in to.entities() {
        match from.get(id) {
            None => {
                let create = Op::Create {
                    entity: id,
                    kind: target.kind,
                    fields: target.fields.clone(),
                };
                if target.kind == EntityKind::Connection {
                    link_creates.push(create);
                } else {
                    creates.push(create);
                }
                if target.deleted {
                    deletes.push(id);
                }
            }
            Some(source) if target.deleted => {
                if !source.deleted {
                    deletes.push(id);
                }
            }
            Some(source) => {
                if source.deleted {
                    undeletes.push(Op::Undelete { entity: id });
                }
                field_sets(id, source, target, &mut sets);
            }
        }
    }
    for (id, source) in from.entities() {
        if !source.deleted && to.get(id).is_none() {
            deletes.push(id);
        }
    }
    deletes.sort();
    let deletes = deletes
        .into_iter()
        .map(|entity| Op::Delete { entity })
        .collect();

    [creates, link_creates, undeletes, sets, deletes].concat()
}

fn field_sets(id: EntityId, source: &Entity, target: &Entity, out: &mut Vec<Op>) {
    let names: BTreeSet<&String> = source.fields.keys().chain(target.fields.keys()).collect();
    for name in names {
        let (old, new) = (source.get(name), target.get(name));
        if old != new {
            out.push(Op::Set {
                entity: id,
                field: name.clone(),
                value: new.clone(),
            });
        }
    }
}
