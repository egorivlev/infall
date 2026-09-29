//! Pure-logic core of a versioned research board.

pub mod board;
pub mod ids;
pub mod schema;

pub use board::{ApplyError, Board, Entity, Op};
pub use ids::{BatchId, BranchId, ChangeId, EntityId, MemberId};
pub use schema::{EntityKind, FieldClass, Fields, SchemaError, Value, field_class, validate_field};
