//! The Branch Graph (contract §18): the shape of every Branch, without the contents of any
//! Change. Members and Admins only.

use axum::Json;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use qoop_core::{
    ACTIVITY_GAP_MS, Activity, Branch, BranchId, MemberId, Moment, Workspace, activities,
};
use serde::{Deserialize, Serialize};

use crate::app::Shared;
use crate::auth::MemberOrAdmin;
use crate::error::{ApiError, ApiQuery};

#[derive(Deserialize)]
pub struct GraphQuery {
    /// The longest pause inside one edit Activity, in milliseconds.
    gap_ms: Option<u64>,
}

#[derive(Serialize)]
pub struct GraphCheckpoint {
    name: String,
    seq: u64,
    author: MemberId,
    at: i64,
}

#[derive(Serialize)]
pub struct GraphBranch {
    id: BranchId,
    name: String,
    seq: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent: Option<Moment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_by: Option<MemberId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_at: Option<i64>,
    checkpoints: Vec<GraphCheckpoint>,
    activities: Vec<Activity>,
}

#[derive(Serialize)]
pub struct Graph {
    branches: Vec<GraphBranch>,
}

/// The shape of one Branch: one pass over its log, no Board is built.
fn shape(ws: &Workspace, b: &Branch, gap_ms: i64) -> GraphBranch {
    let checkpoints: Vec<GraphCheckpoint> = ws
        .checkpoints(b.id())
        .into_iter()
        .map(|c| GraphCheckpoint {
            name: c.name.clone(),
            seq: c.moment.seq,
            author: c.author,
            at: c.at,
        })
        .collect();
    let cuts: Vec<u64> = checkpoints.iter().map(|c| c.seq).collect();
    GraphBranch {
        id: b.id(),
        name: b.name().to_string(),
        seq: b.changes().len() as u64,
        parent: b.parent(),
        created_by: b.created_by(),
        created_at: b.created_at(),
        activities: activities(b.changes(), &cuts, gap_ms),
        checkpoints,
    }
}

/// Every Branch, `main` first, then by when they were started (ties by id).
pub fn graph(ws: &Workspace, gap_ms: i64) -> Graph {
    let mut list: Vec<&Branch> = ws.branches().collect();
    list.sort_by_key(|b| (b.parent().is_some(), b.created_at(), b.id()));
    Graph {
        branches: list.into_iter().map(|b| shape(ws, b, gap_ms)).collect(),
    }
}

pub async fn get_graph(
    State(st): State<Shared>,
    MemberOrAdmin(_): MemberOrAdmin,
    ApiQuery(q): ApiQuery<GraphQuery>,
) -> Result<Response, ApiError> {
    let gap_ms = match q.gap_ms {
        None => ACTIVITY_GAP_MS,
        Some(ms) => i64::try_from(ms).unwrap_or(i64::MAX),
    };
    let graph = {
        let ws = st.workspace.read().await;
        graph(&ws, gap_ms)
    };
    Ok(Json(graph).into_response())
}
