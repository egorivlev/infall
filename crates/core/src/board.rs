//! Board state and the four operations that change it.

use crate::ids::EntityId;
use crate::schema::{EntityKind, Fields, SchemaError, Value, ref_fields, validate_field};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use thiserror::Error;

static NULL: Value = Value::Null;

/// A Card, Frame, Connection, Page Block, Source or Attachment on the Board.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entity {
    pub kind: EntityKind,
    pub fields: Fields,
    pub deleted: bool,
}

impl Entity {
    /// The value of `field`, or `Null` when unset.
    pub fn get(&self, field: &str) -> &Value {
        self.fields.get(field).unwrap_or(&NULL)
    }
}

/// A single edit to a Board.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Op {
    Create {
        entity: EntityId,
        kind: EntityKind,
        fields: Fields,
    },
    Set {
        entity: EntityId,
        field: String,
        value: Value,
    },
    Delete {
        entity: EntityId,
    },
    Undelete {
        entity: EntityId,
    },
}

/// Why an operation was rejected.
#[derive(Debug, Clone, PartialEq, Error, Serialize, Deserialize)]
pub enum ApplyError {
    #[error("entity {0:?} already exists")]
    AlreadyExists(EntityId),
    #[error("entity {0:?} does not exist")]
    UnknownEntity(EntityId),
    #[error("entity {0:?} is deleted")]
    Deleted(EntityId),
    #[error("entity {0:?} is not deleted")]
    NotDeleted(EntityId),
    /// A required reference (a Connection's `from`/`to`, a Block's `card`, an Attachment's
    /// `card`/`source`) is unset or not a reference.
    #[error("entity {0:?} is missing a required reference")]
    MissingEndpoint(EntityId),
    /// A reference points at something that does not exist or is of the wrong kind.
    #[error("{0:?} is not an existing entity of the kind referred to")]
    BadEndpoint(EntityId),
    #[error(transparent)]
    Schema(#[from] SchemaError),
}

/// The state of a Board: every entity ever created, including tombstones.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Board {
    entities: BTreeMap<EntityId, Entity>,
}

impl Board {
    pub fn new() -> Self {
        Self::default()
    }

    /// Applies `op`, or rejects it leaving the Board unchanged.
    pub fn apply(&mut self, op: &Op) -> Result<(), ApplyError> {
        match op {
            Op::Create {
                entity,
                kind,
                fields,
            } => {
                if self.entities.contains_key(entity) {
                    return Err(ApplyError::AlreadyExists(*entity));
                }
                let mut stored = Fields::new();
                for (name, value) in fields {
                    validate_field(*kind, name, value)?;
                    if *value != Value::Null {
                        stored.insert(name.clone(), value.clone());
                    }
                }
                for (end, target) in ref_fields(*kind) {
                    match stored.get(*end) {
                        Some(Value::Ref(id)) => self.check_ref(*id, *target)?,
                        _ => return Err(ApplyError::MissingEndpoint(*entity)),
                    }
                }
                self.entities.insert(
                    *entity,
                    Entity {
                        kind: *kind,
                        fields: stored,
                        deleted: false,
                    },
                );
            }
            Op::Set {
                entity,
                field,
                value,
            } => {
                let e = self.live(*entity)?;
                validate_field(e.kind, field, value)?;
                if let Some((_, target)) = ref_fields(e.kind).iter().find(|(name, _)| name == field)
                {
                    match value {
                        Value::Ref(id) => self.check_ref(*id, *target)?,
                        _ => return Err(ApplyError::MissingEndpoint(*entity)),
                    }
                }
                if let Some(e) = self.entities.get_mut(entity) {
                    if *value == Value::Null {
                        e.fields.remove(field);
                    } else {
                        e.fields.insert(field.clone(), value.clone());
                    }
                }
            }
            Op::Delete { entity } => {
                self.live(*entity)?;
                if let Some(e) = self.entities.get_mut(entity) {
                    e.deleted = true;
                }
            }
            Op::Undelete { entity } => match self.entities.get_mut(entity) {
                None => return Err(ApplyError::UnknownEntity(*entity)),
                Some(e) if !e.deleted => return Err(ApplyError::NotDeleted(*entity)),
                Some(e) => e.deleted = false,
            },
        }
        Ok(())
    }

    fn live(&self, id: EntityId) -> Result<&Entity, ApplyError> {
        match self.entities.get(&id) {
            None => Err(ApplyError::UnknownEntity(id)),
            Some(e) if e.deleted => Err(ApplyError::Deleted(id)),
            Some(e) => Ok(e),
        }
    }

    fn check_ref(&self, id: EntityId, kind: EntityKind) -> Result<(), ApplyError> {
        match self.entities.get(&id) {
            Some(e) if e.kind == kind => Ok(()),
            _ => Err(ApplyError::BadEndpoint(id)),
        }
    }

    pub fn get(&self, id: EntityId) -> Option<&Entity> {
        self.entities.get(&id)
    }

    /// All entities ordered by id, tombstones included.
    pub fn entities(&self) -> impl Iterator<Item = (EntityId, &Entity)> {
        self.entities.iter().map(|(id, e)| (*id, e))
    }

    /// Live, and everything it refers to is live (a Connection's Cards, a Block's Card,
    /// an Attachment's Card and Source).
    pub fn is_visible(&self, id: EntityId) -> bool {
        let Some(e) = self.entities.get(&id) else {
            return false;
        };
        if e.deleted {
            return false;
        }
        ref_fields(e.kind).iter().all(|(end, _)| match e.get(end) {
            Value::Ref(id) => self.entities.get(id).is_some_and(|c| !c.deleted),
            _ => false,
        })
    }

    /// Equal sets of live entities with equal kind and fields; tombstones are ignored.
    pub fn same_content(&self, other: &Board) -> bool {
        let live = |b: &Board| -> Vec<(EntityId, EntityKind, Fields)> {
            b.entities()
                .filter(|(_, e)| !e.deleted)
                .map(|(id, e)| (id, e.kind, e.fields.clone()))
                .collect()
        };
        live(self) == live(other)
    }
}
