//! Branches, the Board, Changes and posting ops (contract §6 "Branches and the Board").

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::header::CONTENT_TYPE;
use axum::response::{IntoResponse, Response};
use infall_core::{
    Board, Branch, BranchId, Change, MemberId, Moment, Op, Value as FieldValue, Workspace, WsError,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::app::Shared;
use crate::auth::{MemberOrAdmin, SignedIn};
use crate::error::{ApiError, ApiJson, ApiQuery};
use crate::live::Hub;
use crate::runs::{self, RESULT_FIELD};
use crate::store::Role;

/// The most ops one request may carry.
pub const MAX_OPS: usize = 200;

/// The most characters one Text value may hold. The `result` of a Run is the one exception
/// (contract §15): it has its own limit and its own checks, in `runs`.
pub const MAX_TEXT_CHARS: usize = 100_000;

/// The request body limit of `POST /api/branches/{id}/ops`: room for one maximal `result`.
pub const OPS_BODY_LIMIT: usize = 2 * 1024 * 1024;

pub(crate) fn text_fits(value: &FieldValue) -> bool {
    match value {
        // Every character is at least one byte, so short strings need no counting.
        FieldValue::Text(s) => s.len() <= MAX_TEXT_CHARS || s.chars().count() <= MAX_TEXT_CHARS,
        _ => true,
    }
}

/// Refuses ops that carry a Text value over the limit. A `result` is not measured here.
fn check_text_sizes(ops: &[Op]) -> Result<(), ApiError> {
    let fits = ops.iter().all(|op| match op {
        Op::Create { fields, .. } => fields
            .iter()
            .all(|(field, value)| field == RESULT_FIELD || text_fits(value)),
        Op::Set { field, value, .. } => field == RESULT_FIELD || text_fits(value),
        Op::Delete { .. } | Op::Undelete { .. } => true,
    });
    if fits {
        Ok(())
    } else {
        Err(ApiError::BadRequest(format!(
            "A text may be at most {MAX_TEXT_CHARS} characters."
        )))
    }
}

/// Ops a Member sent that have passed every check that needs no Board. They still owe the
/// check that a result lands on a Run, which needs the Board at the head and so the write
/// lock: `on_board` gives the ops back once that is done.
pub(crate) struct CheckedOps {
    ops: Vec<Op>,
    carries_result: bool,
}

impl CheckedOps {
    /// Checks what `actor` sent: the size of every Text, and every `result` of a Run.
    pub(crate) fn new(ops: Vec<Op>, actor: MemberId) -> Result<CheckedOps, ApiError> {
        check_text_sizes(&ops)?;
        crate::files::check_ops(&ops)?;
        let carries_result = runs::check_results(&ops, actor)?;
        Ok(CheckedOps {
            ops,
            carries_result,
        })
    }

    /// The ops, once every result they carry is known to land on a Run of the Board at
    /// `head`. Call it under the Workspace write lock, right before recording them.
    pub(crate) fn on_board(self, ws: &Workspace, head: Moment) -> Result<Vec<Op>, ApiError> {
        if self.carries_result {
            let board = ws.head_board(head.branch).map_err(ApiError::internal)?;
            runs::check_set_on_runs(&self.ops, &board)?;
        }
        Ok(self.ops)
    }
}

#[derive(Serialize)]
pub struct BranchInfo {
    id: BranchId,
    name: String,
    seq: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent: Option<Moment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_by: Option<infall_core::MemberId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_at: Option<i64>,
    /// How many Checkpoints the Branch has.
    checkpoints: usize,
}

impl BranchInfo {
    pub fn of(ws: &Workspace, b: &Branch) -> BranchInfo {
        BranchInfo {
            id: b.id(),
            name: b.name().to_string(),
            seq: b.changes().len() as u64,
            parent: b.parent(),
            created_by: b.created_by(),
            created_at: b.created_at(),
            checkpoints: ws.checkpoints(b.id()).len(),
        }
    }
}

/// Whether `who` may read `branch`: Guests see only the Branch named `main`.
pub fn may_read(who: &SignedIn, branch: &Branch) -> bool {
    who.member.role != Role::Guest || branch.name() == "main"
}

/// Resolves a path id to a Branch `who` may read. Guests get `403` for anything that is
/// not `main`, whether or not it exists, so they learn nothing about other Branches.
pub fn readable_branch<'w>(
    ws: &'w Workspace,
    who: &SignedIn,
    raw_id: &str,
) -> Result<&'w Branch, ApiError> {
    let branch = Uuid::parse_str(raw_id)
        .ok()
        .and_then(|id| ws.branch(BranchId(id)));
    match branch {
        Some(b) if may_read(who, b) => Ok(b),
        _ if who.member.role == Role::Guest => {
            Err(ApiError::Forbidden("Guests can read only the main Branch."))
        }
        _ => Err(ApiError::NotFound),
    }
}

/// The Changes of `branch` from index `after` on; `None` if `after` is past the head.
pub fn changes_after(branch: &Branch, after: u64) -> Option<&[Change]> {
    let after = usize::try_from(after).ok()?;
    branch.changes().get(after..)
}

pub async fn list_branches(State(st): State<Shared>, who: SignedIn) -> Json<Value> {
    let ws = st.workspace.read().await;
    let list: Vec<BranchInfo> = ws
        .branches()
        .filter(|b| may_read(&who, b))
        .map(|b| {
            let mut info = BranchInfo::of(&ws, b);
            // A Guest has no history: not even how many Checkpoints there are.
            if who.member.role == Role::Guest {
                info.checkpoints = 0;
            }
            info
        })
        .collect();
    Json(json!({ "branches": list }))
}

#[derive(Serialize)]
struct BoardView<'b> {
    branch: BranchId,
    seq: u64,
    entities: Entities<'b>,
}

/// A Board's entities as one JSON object, written straight from the Board: at size (docs/specs/scale.md)
/// copying them first, or building a `serde_json::Value` of them, costs more than writing them.
struct Entities<'b> {
    board: &'b Board,
    /// Guests get the present only: no tombstones, nothing that points at one.
    guest: bool,
}

impl Serialize for Entities<'_> {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let (board, guest) = (self.board, self.guest);
        s.collect_map(
            board
                .entities()
                .filter(|(id, _)| !guest || board.is_visible(*id)),
        )
    }
}

#[derive(Deserialize)]
pub struct BoardQuery {
    at: Option<u64>,
}

/// The Board at the head, or at the moment `at` (Members and Admins only). Guests get only
/// its visible entities.
pub async fn get_board(
    State(st): State<Shared>,
    who: SignedIn,
    Path(id): Path<String>,
    ApiQuery(q): ApiQuery<BoardQuery>,
) -> Result<Response, ApiError> {
    let guest = who.member.role == Role::Guest;
    if q.at.is_some() && guest {
        return Err(ApiError::Forbidden("Guests cannot read History."));
    }
    let ws = st.workspace.read().await;
    let branch = readable_branch(&ws, &who, &id)?;
    let head = ws.head(branch.id()).map_err(ApiError::internal)?;
    let moment = match q.at {
        Some(seq) if seq > head.seq => {
            return Err(ApiError::BadRequest(
                "`at` is past the head of this Branch.".to_string(),
            ));
        }
        Some(seq) => Moment {
            branch: head.branch,
            seq,
        },
        None => head,
    };
    let board = if moment == head {
        ws.head_board(head.branch).map_err(ApiError::internal)?
    } else {
        Arc::new(ws.board_at(moment).map_err(ApiError::internal)?)
    };
    drop(ws);
    let view = BoardView {
        branch: moment.branch,
        seq: moment.seq,
        entities: Entities {
            board: &board,
            guest,
        },
    };
    let body = serde_json::to_vec(&view).map_err(ApiError::internal)?;
    Ok(([(CONTENT_TYPE, "application/json")], body).into_response())
}

#[derive(Deserialize)]
pub struct ChangesQuery {
    #[serde(default)]
    after: u64,
    /// When given, only Changes with index below it.
    before: Option<u64>,
}

pub async fn get_changes(
    State(st): State<Shared>,
    who: SignedIn,
    Path(id): Path<String>,
    ApiQuery(q): ApiQuery<ChangesQuery>,
) -> Result<Json<Value>, ApiError> {
    if who.member.role == Role::Guest {
        return Err(ApiError::Forbidden("Guests cannot read History."));
    }
    let ws = st.workspace.read().await;
    let branch = readable_branch(&ws, &who, &id)?;
    let changes = changes_after(branch, q.after).ok_or_else(|| {
        ApiError::BadRequest("`after` is past the head of this Branch.".to_string())
    })?;
    let changes = match q.before {
        None => changes,
        Some(before) if before < q.after => {
            return Err(ApiError::BadRequest(
                "`before` is below `after`.".to_string(),
            ));
        }
        Some(before) if before > branch.changes().len() as u64 => {
            return Err(ApiError::BadRequest(
                "`before` is past the head of this Branch.".to_string(),
            ));
        }
        Some(before) => &changes[..(before - q.after) as usize],
    };
    Ok(Json(
        json!({ "seq": branch.changes().len(), "changes": changes }),
    ))
}

#[derive(Deserialize)]
pub struct PostOps {
    ops: Vec<Op>,
}

pub async fn post_ops(
    State(st): State<Shared>,
    MemberOrAdmin(who): MemberOrAdmin,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<PostOps>,
) -> Result<Json<Value>, ApiError> {
    if body.ops.is_empty() || body.ops.len() > MAX_OPS {
        return Err(ApiError::BadRequest(format!(
            "Send between 1 and {MAX_OPS} ops."
        )));
    }
    let ops = CheckedOps::new(body.ops, who.id())?;
    let branch = Uuid::parse_str(&id)
        .map(BranchId)
        .map_err(|_| ApiError::NotFound)?;

    // The write lock is held through persisting and broadcasting, so Changes reach disk,
    // memory and subscribers in the same order.
    let mut ws = st.workspace.write().await;
    let before = ws.head(branch).map_err(|_| ApiError::NotFound)?;
    let ops = ops.on_board(&ws, before)?;
    let mut next = ws.clone();
    let at = st.clock.now();
    let head = next
        .record_all(branch, who.id(), at, ops)
        .map_err(rejected)?;
    let next = crate::app::persist(&st, next).await?;
    *ws = next;
    let changes = ws
        .branch(branch)
        .and_then(|b| changes_after(b, before.seq))
        .map(<[Change]>::to_vec)
        .unwrap_or_default();
    Hub::broadcast_changes(&st, branch, head.seq, &changes);
    drop(ws);
    Ok(Json(json!({ "seq": head.seq, "changes": changes })))
}

/// A core refusal as `409 rejected`, with the core `ApplyError` as `detail`.
pub(crate) fn rejected(e: WsError) -> ApiError {
    match e {
        WsError::UnknownBranch(_) => ApiError::NotFound,
        WsError::Apply(apply) => match serde_json::to_value(&apply) {
            Ok(detail) => ApiError::Rejected(detail),
            Err(e) => ApiError::internal(e),
        },
        other => match serde_json::to_value(&other) {
            Ok(detail) => ApiError::Rejected(detail),
            Err(e) => ApiError::internal(e),
        },
    }
}
