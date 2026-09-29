//! Board state and the four operations that change it.

use crate::ids::EntityId;
use crate::schema::{EntityKind, Fields, SchemaError, Value, validate_field};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use thiserror::Error;

static NULL: Value = Value::Null;

/// A Card, Frame or Connection on the Board.
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
    #[error("connection {0:?} is missing an endpoint")]
    MissingEndpoint(EntityId),
    #[error("endpoint {0:?} is not an existing Card")]
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
                if *kind == EntityKind::Connection {
                    for end in ["from", "to"] {
                        match stored.get(end) {
                            Some(Value::Ref(card)) => self.check_card(*card)?,
                            _ => return Err(ApplyError::MissingEndpoint(*entity)),
                        }
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
                if e.kind == EntityKind::Connection && (field == "from" || field == "to") {
                    match value {
                        Value::Ref(card) => self.check_card(*card)?,
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

    fn check_card(&self, id: EntityId) -> Result<(), ApplyError> {
        match self.entities.get(&id) {
            Some(e) if e.kind == EntityKind::Card => Ok(()),
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

    /// Live, and for a Connection, both endpoints live.
    pub fn is_visible(&self, id: EntityId) -> bool {
        let Some(e) = self.entities.get(&id) else {
            return false;
        };
        if e.deleted {
            return false;
        }
        if e.kind == EntityKind::Connection {
            return ["from", "to"].iter().all(|end| match e.get(end) {
                Value::Ref(card) => self.entities.get(card).is_some_and(|c| !c.deleted),
                _ => false,
            });
        }
        true
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
