//! A Workspace moving onto and off a Team server (docs/specs/team-move.md, decisions 1, 2,
//! 4, 5 and 7, Contract B; api.md §19): `POST /api/workspace/import`, `GET
//! /api/workspace/export`, and the same from the command line (`import-workspace`,
//! `export-workspace`). The files themselves are `local::port`'s.

use std::path::{Path, PathBuf};

use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::header::{CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE};
use axum::http::{HeaderMap, HeaderValue};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use infall_core::{BranchId, MemberId, Workspace};
use serde_json::{Value, json};

use crate::app::{AppState, Shared, blocking};
use crate::auth::{Admin, normalize_email};
use crate::error::ApiError;
use crate::live::Hub;
use crate::local::port::{
    Facts, check_header, copy_new, create_private, export_file, prepare_for_team, remove_scratch,
    scratch_path,
};
use crate::local::{ExportOptions, PortError};
use crate::store::{ImportOutcome, MemberRecord, Role, SqliteStore, Store, StoreError};

const LOCAL_IMPORT: &str =
    "A Local Workspace is made from a Workspace file on the desktop app's start screen.";
const LOCAL_EXPORT: &str = "A Local Workspace is exported from the desktop app's start screen.";

/// Whether the Research Content is untouched: `main` is the only Branch and has no
/// Changes and no Checkpoints.
fn content_is_empty(ws: &Workspace) -> bool {
    let mut branches = ws.branches();
    match (branches.next(), branches.next()) {
        (Some(main), None) => {
            main.name() == "main"
                && main.changes().is_empty()
                && main.recorded_checkpoints().is_empty()
        }
        _ => false,
    }
}

/// Whether this is a Team Workspace that a Workspace file may come into (decision 1):
/// `main` the only Branch, with no Changes and no Checkpoints, and no To-dos and no Comments.
/// Members and invites may exist. Always false in a Local Workspace.
pub async fn is_empty(st: &Shared) -> Result<bool, ApiError> {
    if st.local.is_some() {
        return Ok(false);
    }
    if !content_is_empty(&*st.workspace.read().await) {
        return Ok(false);
    }
    let (todos, comments) = blocking(st, |s| Ok((s.todos()?.len(), s.comment_total()?))).await?;
    Ok(todos == 0 && comments == 0)
}

/// Where this server makes its private scratch files: beside its database, or in the
/// system's temporary folder for a database that is not a file.
pub(crate) fn scratch_file(st: &AppState, what: &str) -> Result<PathBuf, ApiError> {
    let db = &st.config.db;
    let name = db.to_string_lossy();
    let base = if name.is_empty() || name == ":memory:" || name.starts_with("file:") {
        std::env::temp_dir().join("infall-server.db")
    } else {
        db.clone()
    };
    scratch_path(&base, what).map_err(ApiError::internal)
}

/// Why bringing a file in did not happen.
enum BringError {
    Port(PortError),
    Store(StoreError),
    NotEmpty,
}

impl From<BringError> for ApiError {
    fn from(e: BringError) -> ApiError {
        match e {
            BringError::NotEmpty => ApiError::NotEmpty,
            BringError::Port(PortError::NotAWorkspaceFile) => ApiError::NotAWorkspaceFile,
            BringError::Port(PortError::NewerVersion) => ApiError::NewerVersion,
            BringError::Port(other) => ApiError::internal(other),
            BringError::Store(e) => ApiError::from(e),
        }
    }
}

impl std::fmt::Display for BringError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BringError::NotEmpty => f.write_str(
                "the Workspace on this server is not empty (it has Changes, Checkpoints, Branches, To-dos or Comments); a Workspace file can be brought only into an empty one",
            ),
            BringError::Port(e) => write!(f, "{e}"),
            BringError::Store(e) => write!(f, "{e}"),
        }
    }
}

/// The id of `main`, if the Workspace has one.
fn main_of(ws: &Workspace) -> Option<BranchId> {
    ws.branch_by_name("main").map(|b| b.id())
}

/// Prepares the file at `scratch` (a private copy) for `store` and brings it in, with
/// `admin` as the importing Admin. Blocking.
fn bring_in(
    store: &dyn Store,
    scratch: &Path,
    admin: MemberId,
    team_main: Option<BranchId>,
) -> Result<Facts, BringError> {
    let facts = prepare_for_team(scratch, admin, team_main).map_err(BringError::Port)?;
    match store.import_prepared(scratch).map_err(BringError::Store)? {
        ImportOutcome::Done => Ok(facts),
        ImportOutcome::NotEmpty => Err(BringError::NotEmpty),
    }
}

/// The Members as the answer of an import lists them: every Member and Admin, with whether
/// someone signs in as them.
fn member_list(members: &[MemberRecord]) -> Vec<Value> {
    members
        .iter()
        .filter(|m| m.role != Role::Guest)
        .map(|m| json!({ "id": m.id, "name": m.name, "claimed": m.claimed() }))
        .collect()
}

/// Writes the request body to `to` (a new private file), refusing more than `limit` bytes.
async fn receive(headers: &HeaderMap, body: Body, to: &Path, limit: u64) -> Result<(), ApiError> {
    use tokio::io::AsyncWriteExt;
    let too_large = || {
        ApiError::TooLarge(format!(
            "A Workspace file may be at most {} MB here.",
            limit / (1024 * 1024)
        ))
    };
    let declared = headers
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if declared.is_some_and(|n| n > limit) {
        return Err(too_large());
    }
    let file = create_private(to).map_err(ApiError::internal)?;
    let mut file = tokio::fs::File::from_std(file);
    let mut stream = body.into_data_stream();
    let mut received: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| {
            ApiError::BadRequest("The Workspace file did not arrive whole.".to_string())
        })?;
        received += chunk.len() as u64;
        if received > limit {
            return Err(too_large());
        }
        file.write_all(&chunk).await.map_err(ApiError::internal)?;
    }
    file.flush().await.map_err(ApiError::internal)?;
    file.sync_all().await.map_err(ApiError::internal)?;
    Ok(())
}

/// `POST /api/workspace/import`: an Admin of an empty Team Workspace brings in a Workspace
/// file (the body, `application/octet-stream`, at most `INFALL_MAX_IMPORT_MB`). A Local
/// Workspace's file: its Member's work becomes the Admin's (decision 2). A Team Workspace's:
/// who exported it becomes the Admin, every other Member arrives as a name that cannot sign
/// in (decision 7). One transaction: on any failure nothing changes. Then everyone connected
/// catches up with the new Workspace.
pub async fn import(
    State(st): State<Shared>,
    Admin(who): Admin,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<Value>, ApiError> {
    crate::local::refuse(&st, LOCAL_IMPORT)?;
    if !is_empty(&st).await? {
        return Err(ApiError::NotEmpty);
    }
    let scratch = scratch_file(&st, "upload")?;
    let result = import_from(&st, &headers, body, &scratch, who.id()).await;
    let _ = tokio::task::spawn_blocking(move || remove_scratch(&scratch)).await;
    result
}

async fn import_from(
    st: &Shared,
    headers: &HeaderMap,
    body: Body,
    scratch: &Path,
    admin: MemberId,
) -> Result<Json<Value>, ApiError> {
    receive(headers, body, scratch, st.config.max_import_bytes).await?;
    // The write lock is held from the check to the new Workspace being in memory, so no
    // edit falls in between.
    let mut ws = st.workspace.write().await;
    let team_main = main_of(&ws);
    let store = st.store.clone();
    let scratch = scratch.to_path_buf();
    let (facts, fresh) = tokio::task::spawn_blocking(move || {
        let facts = bring_in(&*store, &scratch, admin, team_main)?;
        let fresh = store
            .load_workspace()
            .map_err(BringError::Store)?
            .ok_or(BringError::Port(PortError::NotAWorkspaceFile))?;
        Ok::<_, BringError>((facts, fresh))
    })
    .await
    .map_err(|e| ApiError::internal(format!("import task failed: {e}")))??;
    *ws = fresh;
    drop(ws);
    Hub::broadcast_resync(st);
    let members = blocking(st, |s| s.members()).await?;
    tracing::info!(admin = %admin.0, you_were = %facts.owner_name, "workspace file brought in");
    Ok(Json(json!({
        "members": member_list(&members),
        "you_were": facts.owner_name,
    })))
}

/// The name a downloaded Workspace file is offered under: the server's host.
fn file_name(public_origin: &str) -> String {
    let host = public_origin
        .split_once("://")
        .map_or(public_origin, |(_, h)| h);
    let safe: String = host
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    format!("{safe}.{}", crate::local::WORKSPACE_FILE_EXTENSION)
}

/// `GET /api/workspace/export`: an Admin of a Team Workspace takes it out as a Workspace
/// file (decision 5): every Branch, the history, Checkpoints, To-dos, Suggestions and
/// Comments, and the Members as names only, recording that this Admin exported it.
pub async fn export(State(st): State<Shared>, Admin(who): Admin) -> Result<Response, ApiError> {
    use tokio::io::AsyncReadExt;
    crate::local::refuse(&st, LOCAL_EXPORT)?;
    let db = st.config.db.clone();
    let dest = scratch_file(&st, "download")?;
    let by = who.id();
    {
        let (db, dest) = (db.clone(), dest.clone());
        tokio::task::spawn_blocking(move || {
            export_file(&db, &dest, Some(by), ExportOptions::default())
        })
        .await
        .map_err(|e| ApiError::internal(format!("export task failed: {e}")))?
        .map_err(ApiError::internal)?;
    }
    tracing::info!(by = %by.0, "workspace file exported");
    let file = tokio::fs::File::open(&dest)
        .await
        .map_err(ApiError::internal)?;
    let len = file.metadata().await.map_err(ApiError::internal)?.len();
    // An open file stays readable once its name is gone (unix); elsewhere it goes at the end.
    #[cfg(unix)]
    let _ = std::fs::remove_file(&dest);
    let stream = futures_util::stream::unfold(Some((file, dest)), |state| async move {
        let (mut file, dest) = state?;
        let mut buf = vec![0u8; 64 * 1024];
        match file.read(&mut buf).await {
            Ok(0) => {
                drop(file);
                let _ = std::fs::remove_file(&dest);
                None
            }
            Ok(n) => {
                buf.truncate(n);
                Some((
                    Ok::<_, std::io::Error>(Bytes::from(buf)),
                    Some((file, dest)),
                ))
            }
            Err(e) => {
                drop(file);
                let _ = std::fs::remove_file(&dest);
                Some((Err(e), None))
            }
        }
    });
    let disposition = format!(
        "attachment; filename=\"{}\"",
        file_name(&st.config.public_origin)
    );
    let mut res = Body::from_stream(stream).into_response();
    let h = res.headers_mut();
    h.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    h.insert(
        CONTENT_DISPOSITION,
        HeaderValue::from_str(&disposition).map_err(ApiError::internal)?,
    );
    h.insert(CONTENT_LENGTH, HeaderValue::from(len));
    h.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(res)
}

// ---------------------------------------------------------------- the command line

/// What `infall-server import-workspace` did.
#[derive(Debug, Clone)]
pub struct ImportSummary {
    /// The Admin who took over the work.
    pub admin: String,
    /// Whose work it was in the file.
    pub you_were: String,
    /// Every Member and Admin now, by name, with whether someone signs in as them.
    pub members: Vec<(String, bool)>,
}

/// `infall-server import-workspace <file> --admin-email <e>`: the same rules as `POST
/// /api/workspace/import`, with the existing Admin of that email as the importing Admin.
/// Refuses unless the Workspace is empty or when there is no such Admin. A server that is
/// running on the same database refuses to write until it is restarted.
pub fn import_from_command_line(
    db: &Path,
    file: &Path,
    admin_email: &str,
) -> Result<ImportSummary, String> {
    check_header(file).map_err(|e| e.to_string())?;
    let store =
        SqliteStore::open(db).map_err(|e| format!("cannot open database {}: {e}", db.display()))?;
    let email = normalize_email(admin_email);
    let admin = store
        .member_by_email(&email)
        .map_err(|e| e.to_string())?
        .filter(|m| m.role == Role::Admin)
        .ok_or_else(|| {
            format!("no Admin has the email {email}; make one with `create-admin` first")
        })?;
    let team_main = store
        .load_workspace()
        .map_err(|e| e.to_string())?
        .as_ref()
        .and_then(main_of);
    let scratch = scratch_path(db, "import").map_err(|e| e.to_string())?;
    let result = copy_new(file, &scratch)
        .map_err(|e| format!("cannot copy {} beside the database: {e}", file.display()))
        .and_then(|()| bring_in(&store, &scratch, admin.id, team_main).map_err(|e| e.to_string()));
    remove_scratch(&scratch);
    let facts = result?;
    let members = store
        .members()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|m| m.role != Role::Guest)
        .map(|m| {
            let claimed = m.claimed();
            (m.name, claimed)
        })
        .collect();
    Ok(ImportSummary {
        admin: admin.name,
        you_were: facts.owner_name,
        members,
    })
}

/// `infall-server export-workspace <dest>`: a Workspace file of the database, made as
/// `GET /api/workspace/export` makes one, with the oldest Admin recorded as who exported it.
/// Safe while a server runs on the database, in this process or another: the file is a
/// consistent snapshot.
pub fn export_from_command_line(db: &Path, dest: &Path) -> Result<(), String> {
    crate::local::export_workspace(db, dest).map_err(|e| e.to_string())
}
