#![allow(dead_code)]

use qoop_core::*;

pub fn text(s: &str) -> Value {
    Value::Text(s.to_string())
}

pub fn card(title: &str) -> (EntityId, Op) {
    let id = EntityId::new();
    let mut fields = Fields::new();
    fields.insert("title".to_string(), text(title));
    (
        id,
        Op::Create {
            entity: id,
            kind: EntityKind::Card,
            fields,
        },
    )
}

pub fn connect(from: EntityId, to: EntityId) -> (EntityId, Op) {
    let id = EntityId::new();
    let mut fields = Fields::new();
    fields.insert("from".to_string(), Value::Ref(from));
    fields.insert("to".to_string(), Value::Ref(to));
    (
        id,
        Op::Create {
            entity: id,
            kind: EntityKind::Connection,
            fields,
        },
    )
}

pub fn set(entity: EntityId, field: &str, value: Value) -> Op {
    Op::Set {
        entity,
        field: field.to_string(),
        value,
    }
}

/// Turns arbitrary bytes into operations and applies the valid ones; returns the ops that were accepted.
///
/// The seed is read three bytes at a time as (action, pick, payload). The action (mod 6) chooses:
/// create Card, create Connection between two picked Cards, set `title`, set `x`, Delete, Undelete.
/// Picks index the Board's existing entities in id order; ops the Board rejects are skipped.
pub fn scribble(board: &mut Board, seed: &[u8]) -> Vec<Op> {
    let mut accepted = Vec::new();
    for chunk in seed.chunks_exact(3) {
        let (action, pick, payload) = (chunk[0], chunk[1] as usize, chunk[2]);
        let ids: Vec<EntityId> = board.entities().map(|(id, _)| id).collect();
        let cards: Vec<EntityId> = board
            .entities()
            .filter(|(_, e)| e.kind == EntityKind::Card)
            .map(|(id, _)| id)
            .collect();
        let pick_of = |list: &[EntityId], i: usize| list.get(i % list.len().max(1)).copied();
        let op = match action % 6 {
            0 => Some(card(&format!("card {payload}")).1),
            1 => match (pick_of(&cards, pick), pick_of(&cards, payload as usize)) {
                (Some(a), Some(b)) => Some(connect(a, b).1),
                _ => None,
            },
            2 => pick_of(&ids, pick).map(|id| {
                let value = if payload % 5 == 0 {
                    Value::Null
                } else {
                    text(&format!("title {payload}"))
                };
                set(id, "title", value)
            }),
            3 => pick_of(&ids, pick).map(|id| set(id, "x", Value::Float(f64::from(payload)))),
            4 => pick_of(&ids, pick).map(|entity| Op::Delete { entity }),
            _ => pick_of(&ids, pick).map(|entity| Op::Undelete { entity }),
        };
        if let Some(op) = op
            && board.apply(&op).is_ok()
        {
            accepted.push(op);
        }
    }
    accepted
}
