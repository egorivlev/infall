//! History, Checkpoints, Restore and Branches (contract §9). Members and Admins only.

use axum::Json;
use axum::extract::{Path, State};
use qoop_core::{Branch, BranchId, Change, Moment, Workspace, WsError};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::app::Shared;
use crate::auth::MemberOrAdmin;
use crate::boards::{BranchInfo, changes_after};
use crate::error::{ApiError, ApiJson};
use crate::live::Hub;

/// The longest Checkpoint name, in characters after trimming.
pub const MAX_CHECKPOINT_NAME_CHARS: usize = 80;
/// The longest Branch name, in characters after trimming.
pub const MAX_BRANCH_NAME_CHARS: usize = 60;

/// Trims `name` and checks it is 1 to `max` characters with no control characters.
pub(crate) fn clean_name(name: &str, what: &str, max: usize) -> Result<String, ApiError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > max || name.chars().any(char::is_control) {
        return Err(ApiError::BadRequest(format!(
            "The {what} name must be 1 to {max} characters, with no control characters."
        )));
    }
    Ok(name.to_string())
}

fn branch_id(raw: &str) -> Result<BranchId, ApiError> {
    Uuid::parse_str(raw)
        .map(BranchId)
        .map_err(|_| ApiError::NotFound)
}

fn existing_branch<'w>(ws: &'w Workspace, raw: &str) -> Result<&'w Branch, ApiError> {
    ws.branch(branch_id(raw)?).ok_or(ApiError::NotFound)
}

/// A core refusal of a Checkpoint, Restore or fork. `missing` says what a moment that
/// does not exist means for this call.
fn refused(e: WsError, missing: &str) -> ApiError {
    match e {
        WsError::UnknownBranch(_) => ApiError::NotFound,
        WsError::BadMoment(_) => ApiError::BadRequest(missing.to_string()),
        WsError::NameTaken(_) => ApiError::NameTaken,
        WsError::EmptyName => ApiError::BadRequest("The name must not be empty.".to_string()),
        WsError::Apply(e) => ApiError::internal(e),
    }
}

pub async fn list_checkpoints(
    State(st): State<Shared>,
    MemberOrAdmin(_): MemberOrAdmin,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let ws = st.workspace.read().await;
    let branch = existing_branch(&ws, &id)?;
    Ok(Json(json!({ "checkpoints": ws.checkpoints(branch.id()) })))
}

#[derive(Deserialize)]
pub struct NewCheckpoint {
    name: String,
    seq: Option<u64>,
}

pub async fn create_checkpoint(
    State(st): State<Shared>,
    MemberOrAdmin(who): MemberOrAdmin,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<NewCheckpoint>,
) -> Result<Json<Value>, ApiError> {
    let name = clean_name(&body.name, "Checkpoint", MAX_CHECKPOINT_NAME_CHARS)?;
    let branch = branch_id(&id)?;

    // As in `post_ops`: the write lock is held through persisting and broadcasting.
    let mut ws = st.workspace.write().await;
    let head = ws.head(branch).map_err(|_| ApiError::NotFound)?;
    let moment = Moment {
        branch,
        seq: body.seq.unwrap_or(head.seq),
    };
    let mut next = ws.clone();
    next.checkpoint(&name, moment, who.id(), st.clock.now())
        .map_err(|e| refused(e, "`seq` is past the head of this Branch."))?;
    let next = crate::app::persist(&st, next).await?;
    *ws = next;
    let checkpoint = ws
        .checkpoints(branch)
        .into_iter()
        .find(|c| c.name == name)
        .cloned()
        .ok_or_else(|| ApiError::internal("the new Checkpoint is missing"))?;
    Hub::broadcast_checkpoint(&st, branch, &checkpoint);
    drop(ws);
    Ok(Json(json!({ "checkpoint": checkpoint })))
}

#[derive(Deserialize)]
pub struct RestoreTo {
    to_seq: u64,
}

pub async fn restore(
    State(st): State<Shared>,
    MemberOrAdmin(who): MemberOrAdmin,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<RestoreTo>,
) -> Result<Json<Value>, ApiError> {
    let branch = branch_id(&id)?;

    let mut ws = st.workspace.write().await;
    let before = ws.head(branch).map_err(|_| ApiError::NotFound)?;
    let mut next = ws.clone();
    let head = next
        .restore(branch, body.to_seq, who.id(), st.clock.now())
        .map_err(|e| refused(e, "`to_seq` is past the head of this Branch."))?;
    // Persisted even when no Change was appended: a Restore can also forget Merges,
    // which changes sync points on this and other Branches.
    let next = crate::app::persist(&st, next).await?;
    *ws = next;
    let changes = ws
        .branch(branch)
        .and_then(|b| changes_after(b, before.seq))
        .map(<[Change]>::to_vec)
        .unwrap_or_default();
    if !changes.is_empty() {
        Hub::broadcast_changes(&st, branch, head.seq, &changes);
    }
    drop(ws);
    Ok(Json(json!({ "seq": head.seq, "changes": changes })))
}

#[derive(Deserialize)]
pub struct NewBranch {
    name: String,
    from: Moment,
}

pub async fn create_branch(
    State(st): State<Shared>,
    MemberOrAdmin(who): MemberOrAdmin,
    ApiJson(body): ApiJson<NewBranch>,
) -> Result<Json<Value>, ApiError> {
    let name = clean_name(&body.name, "Branch", MAX_BRANCH_NAME_CHARS)?;
    const NO_MOMENT: &str = "`from` is not a moment that exists.";

    let mut ws = st.workspace.write().await;
    let mut next = ws.clone();
    let id = next
        .fork(&name, body.from, who.id(), st.clock.now())
        .map_err(|e| match e {
            // Here an unknown Branch is part of the body, not of the path.
            WsError::UnknownBranch(_) => ApiError::BadRequest(NO_MOMENT.to_string()),
            other => refused(other, NO_MOMENT),
        })?;
    let next = crate::app::persist(&st, next).await?;
    *ws = next;
    let all: Vec<BranchInfo> = ws.branches().map(|b| BranchInfo::of(&ws, b)).collect();
    Hub::broadcast_branches(&st, &all);
    let created = ws
        .branch(id)
        .map(|b| BranchInfo::of(&ws, b))
        .ok_or_else(|| ApiError::internal("the new Branch is missing"))?;
    drop(ws);
    Ok(Json(json!({ "branch": created })))
}
