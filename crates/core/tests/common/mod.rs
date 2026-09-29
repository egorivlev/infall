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
