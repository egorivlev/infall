//! Entity kinds, field values and the field table.

use crate::ids::EntityId;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use thiserror::Error;

/// A field value. `Null` and "never set" are the same thing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Value {
    Null,
    Float(f64),
    Text(String),
    Ref(EntityId),
}

/// The kind of an entity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum EntityKind {
    Card,
    Frame,
    Connection,
    /// One block of a Card's Page.
    Block,
    /// An external reference: a paper, preprint or web page.
    Source,
    /// A Source attached to a Card.
    Attachment,
}

impl EntityKind {
    /// Whether entities of this kind refer to other entities, so must be created after them.
    pub fn has_refs(self) -> bool {
        !ref_fields(self).is_empty()
    }
}

/// The fields of `kind` that must refer to an existing entity, with the kind they refer to.
/// All of them are required at creation and can never be cleared.
pub fn ref_fields(kind: EntityKind) -> &'static [(&'static str, EntityKind)] {
    match kind {
        EntityKind::Connection => &[("from", EntityKind::Card), ("to", EntityKind::Card)],
        EntityKind::Block => &[("card", EntityKind::Card)],
        EntityKind::Attachment => &[("card", EntityKind::Card), ("source", EntityKind::Source)],
        EntityKind::Card | EntityKind::Frame | EntityKind::Source => &[],
    }
}

/// Named fields of an entity, ordered by name.
pub type Fields = BTreeMap<String, Value>;

/// Whether a field is Content or Layout.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum FieldClass {
    Content,
    Layout,
}

/// Why a field value was rejected.
#[derive(Debug, Clone, PartialEq, Error, Serialize, Deserialize)]
pub enum SchemaError {
    #[error("unknown field `{field}` on {kind:?}")]
    UnknownField { kind: EntityKind, field: String },
    #[error("wrong value type for field `{field}`")]
    WrongType { field: String },
    #[error("field `{field}` must be a finite number")]
    NotFinite { field: String },
    #[error("invalid status `{0}`")]
    BadStatus(String),
    #[error("invalid connection kind `{0}`")]
    BadKind(String),
    #[error("invalid block type `{0}`")]
    BadBlockType(String),
}

/// Types a Block may have.
const BLOCK_TYPES: [&str; 2] = ["text", "visual"];

/// Kinds a Connection may have; unset means `related`.
const KINDS: [&str; 3] = ["related", "directed", "contradicts"];

/// Statuses a Card may have.
const STATUSES: [&str; 5] = ["idea", "reading", "understood", "open_question", "dead_end"];

#[derive(Clone, Copy)]
enum Type {
    Text,
    Float,
    Ref,
}

fn spec(kind: EntityKind, field: &str) -> Option<(FieldClass, Type)> {
    use EntityKind::*;
    use FieldClass::*;
    match (kind, field) {
        (Card, "title" | "summary" | "status") => Some((Content, Type::Text)),
        (Frame, "title") => Some((Content, Type::Text)),
        (Card | Frame, "x" | "y" | "w" | "h") => Some((Layout, Type::Float)),
        (Connection, "from" | "to") => Some((Content, Type::Ref)),
        (Connection, "label" | "kind") => Some((Content, Type::Text)),
        (Block, "card") => Some((Content, Type::Ref)),
        (Block, "type" | "text" | "title") => Some((Content, Type::Text)),
        // Where a Block sits in its Page is layout: on a Merge the target's order wins.
        (Block, "order") => Some((Layout, Type::Text)),
        (Source, "url" | "doi" | "title" | "authors" | "year" | "note") => {
            Some((Content, Type::Text))
        }
        (Attachment, "card" | "source") => Some((Content, Type::Ref)),
        _ => None,
    }
}

/// The class of a field, or `None` if the field is unknown for that kind.
pub fn field_class(kind: EntityKind, field: &str) -> Option<FieldClass> {
    spec(kind, field).map(|(class, _)| class)
}

/// Checks that `value` is acceptable for `field` on an entity of `kind`.
/// `Null` is accepted for every known field.
pub fn validate_field(kind: EntityKind, field: &str, value: &Value) -> Result<(), SchemaError> {
    let (_, ty) = spec(kind, field).ok_or_else(|| SchemaError::UnknownField {
        kind,
        field: field.to_string(),
    })?;
    let wrong = || SchemaError::WrongType {
        field: field.to_string(),
    };
    match (value, ty) {
        (Value::Null, _) => Ok(()),
        (Value::Float(f), Type::Float) => {
            if f.is_finite() {
                Ok(())
            } else {
                Err(SchemaError::NotFinite {
                    field: field.to_string(),
                })
            }
        }
        (Value::Text(s), Type::Text) => {
            if kind == EntityKind::Card && field == "status" && !STATUSES.contains(&s.as_str()) {
                Err(SchemaError::BadStatus(s.clone()))
            } else if kind == EntityKind::Connection
                && field == "kind"
                && !KINDS.contains(&s.as_str())
            {
                Err(SchemaError::BadKind(s.clone()))
            } else if kind == EntityKind::Block
                && field == "type"
                && !BLOCK_TYPES.contains(&s.as_str())
            {
                Err(SchemaError::BadBlockType(s.clone()))
            } else {
                Ok(())
            }
        }
        (Value::Ref(_), Type::Ref) => Ok(()),
        _ => Err(wrong()),
    }
}
