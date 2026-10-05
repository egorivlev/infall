//! Merge between a Branch and its direct parent (contract §10). Members and Admins only.

use axum::Json;
use axum::extract::State;
use qoop_core::{
    BranchId, Change, ConflictKey, Decision, Decisions, MergeError, MergePlan, WsError,
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::app::Shared;
use crate::auth::MemberOrAdmin;
use crate::boards::{BranchInfo, changes_after};
use crate::error::{ApiError, ApiJson, ApiQuery};
use crate::history::{MAX_CHECKPOINT_NAME_CHARS, clean_name};
use crate::live::Hub;

/// A core value as the `detail` of an error.
fn detail(value: &impl serde::Serialize) -> Result<Value, ApiError> {
    serde_json::to_value(value).map_err(ApiError::internal)
}

fn bad_decision(key: &ConflictKey) -> ApiError {
    detail(key).map_or_else(|e| e, ApiError::BadDecision)
}

/// A core refusal to plan or apply a Merge, in the contract's terms.
fn refused(e: MergeError) -> ApiError {
    match e {
        MergeError::NotParentAndChild => ApiError::NotParentAndChild,
        MergeError::Stale => ApiError::Stale,
        MergeError::Undecided(keys) => detail(&keys).map_or_else(|e| e, ApiError::Undecided),
        MergeError::UnknownConflict(key) | MergeError::CustomNotAllowed(key) => bad_decision(&key),
        MergeError::Ws(WsError::UnknownBranch(_)) => ApiError::NotFound,
        MergeError::Ws(WsError::NameTaken(_)) => ApiError::NameTaken,
        MergeError::Ws(WsError::EmptyName) => {
            ApiError::BadRequest("The name must not be empty.".to_string())
        }
        MergeError::Ws(WsError::Apply(e)) => detail(&e).map_or_else(|e| e, ApiError::Rejected),
        // The core checks the plan's heads before it reads any moment, so a moment that
        // does not exist is refused as stale and never gets here.
        MergeError::Ws(e @ WsError::BadMoment(_)) => ApiError::internal(e),
    }
}

#[derive(Deserialize)]
pub struct PlanQuery {
    source: String,
    target: String,
}

fn branch_id(raw: &str) -> Result<BranchId, ApiError> {
    Uuid::parse_str(raw)
        .map(BranchId)
        .map_err(|_| ApiError::NotFound)
}

/// What merging `source` into `target` would do right now. Changes nothing.
pub async fn plan(
    State(st): State<Shared>,
    MemberOrAdmin(_): MemberOrAdmin,
    ApiQuery(q): ApiQuery<PlanQuery>,
) -> Result<Json<Value>, ApiError> {
    let (source, target) = (branch_id(&q.source)?, branch_id(&q.target)?);
    let ws = st.workspace.read().await;
    let plan = ws.plan_merge(source, target).map_err(refused)?;
    Ok(Json(json!({ "plan": plan })))
}

#[derive(Deserialize)]
pub struct ApplyMerge {
    plan: MergePlan,
    /// Read as a plain list so that a repeated key is a `bad_decision` naming the key,
    /// not a body of the wrong shape.
    decisions: Vec<(ConflictKey, Decision)>,
    checkpoint: Option<String>,
}

pub async fn apply(
    State(st): State<Shared>,
    MemberOrAdmin(who): MemberOrAdmin,
    ApiJson(body): ApiJson<ApplyMerge>,
) -> Result<Json<Value>, ApiError> {
    let decisions = Decisions::try_from(body.decisions).map_err(|e| bad_decision(&e.0))?;
    let name = body
        .checkpoint
        .as_deref()
        .map(|name| clean_name(name, "Checkpoint", MAX_CHECKPOINT_NAME_CHARS))
        .transpose()?;
    let plan = body.plan;
    let target = plan.target.branch;

    // As in `post_ops`: the write lock is held through persisting and broadcasting. The
    // core recomputes the plan here and refuses any difference as stale.
    let mut ws = st.workspace.write().await;
    let mut next = ws.clone();
    let head = next
        .apply_merge(&plan, &decisions, who.id(), st.clock.now(), name.as_deref())
        .map_err(refused)?;
    // Persisted even when no Change was appended: the Merge is remembered as the new
    // base between the two Branches, and a Checkpoint may have been made.
    let next = crate::app::persist(&st, next).await?;
    *ws = next;
    let changes = ws
        .branch(target)
        .and_then(|b| changes_after(b, plan.target.seq))
        .map(<[Change]>::to_vec)
        .unwrap_or_default();
    let checkpoint = match &name {
        Some(name) => Some(
            ws.checkpoints(target)
                .into_iter()
                .find(|c| &c.name == name)
                .cloned()
                .ok_or_else(|| ApiError::internal("the new Checkpoint is missing"))?,
        ),
        None => None,
    };
    if !changes.is_empty() {
        Hub::broadcast_changes(&st, target, head.seq, &changes);
    }
    if let Some(checkpoint) = &checkpoint {
        Hub::broadcast_checkpoint(&st, target, checkpoint);
    }
    let all: Vec<BranchInfo> = ws.branches().map(|b| BranchInfo::of(&ws, b)).collect();
    Hub::broadcast_branches(&st, &all);
    drop(ws);

    let mut out = json!({ "seq": head.seq, "changes": changes });
    if let Some(checkpoint) = checkpoint {
        out["checkpoint"] = json!(checkpoint);
    }
    Ok(Json(out))
}
