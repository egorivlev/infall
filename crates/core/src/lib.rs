//! Pure-logic core of a versioned research board.

pub mod board;
pub mod diff;
pub mod ids;
pub mod merge;
pub mod schema;
pub mod workspace;

pub use board::{ApplyError, Board, Entity, Op};
pub use diff::diff_ops;
pub use ids::{BatchId, BranchId, ChangeId, EntityId, MemberId};
pub use merge::{
    Conflict, ConflictKey, Decision, Decisions, MergeError, MergePlan, RepeatedDecision, Side,
    resolve, three_way,
};
pub use schema::{
    EntityKind, FieldClass, Fields, SchemaError, Value, field_class, ref_fields, validate_field,
};
pub use workspace::{Branch, Change, Checkpoint, Moment, Origin, SyncPoint, Workspace, WsError};
