//! Shared state, router assembly, static files with SPA fallback, and response headers.

use std::sync::Arc;

use axum::Router;
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::HeaderValue;
use axum::http::header::{
    CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE, REFERRER_POLICY, X_CONTENT_TYPE_OPTIONS,
};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use qoop_core::Workspace;
use serde_json::json;
use tokio::sync::{RwLock, Semaphore, watch};
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

use crate::ai::{self, AiState};
use crate::auth::{self, Throttle};
use crate::config::Config;
use crate::error::ApiError;
use crate::live::{self, Hub};
use crate::store::{Store, StoreResult};
use crate::tokens::RateLimit;
use crate::{
    Clock, boards, chat, history, local, mcp, merges, people, sources, suggestions, todos, tokens,
};

/// Request bodies over this are refused.
pub const BODY_LIMIT: usize = 1024 * 1024;

const CSP: &str = "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'";

/// The policy of the page a Visual runs in (contract §13): sandboxed into an opaque origin,
/// no network, embeddable only by the app itself.
const VISUAL_FRAME_CSP: &str = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

/// The host page of a Visual. It carries no data, only the message protocol of §13.
const VISUAL_FRAME: &str = include_str!("../assets/visual-frame.html");

/// Marks a response that brings its own security headers, so `security_headers` leaves it
/// alone.
#[derive(Clone, Copy)]
struct OwnSecurityHeaders;

/// Everything handlers share.
pub struct AppState {
    pub config: Config,
    pub store: Arc<dyn Store>,
    /// The one Workspace, read from the store at start.
    pub workspace: RwLock<Workspace>,
    pub hub: Hub,
    pub throttle: Throttle,
    /// Requests per access token on the tool endpoint.
    pub tool_rate: RateLimit,
    /// Source lookups per Member (contract §17).
    pub lookup_rate: RateLimit,
    /// The OpenRouter path of the AI sidebar: its HTTP client, turn limit and model list.
    pub ai: AiState,
    pub clock: Clock,
    /// Limits concurrent Argon2 work (each run holds ~19 MiB).
    pub hashing: Semaphore,
    /// A real Argon2id hash of a random password, verified against when an email is
    /// unknown so that login timing is the same either way.
    pub dummy_hash: String,
    /// Flips to `true` when the server is shutting down; live connections close.
    /// Held here so that it outlives every connection.
    pub shutdown: Arc<watch::Sender<bool>>,
    /// Set when this is a Local Workspace run by the desktop app; `None` for a Team
    /// Workspace.
    pub local: Option<crate::local::LocalMode>,
}

pub type Shared = Arc<AppState>;

/// Runs a blocking store call off the async threads.
pub async fn blocking<T: Send + 'static>(
    st: &Shared,
    f: impl FnOnce(&dyn Store) -> StoreResult<T> + Send + 'static,
) -> Result<T, ApiError> {
    let store = st.store.clone();
    tokio::task::spawn_blocking(move || f(&*store))
        .await
        .map_err(|e| ApiError::internal(format!("store task failed: {e}")))?
        .map_err(ApiError::from)
}

/// Writes `ws` as the new snapshot and hands it back; on failure memory is left as it was
/// by the caller, which only swaps the snapshot in after this succeeds.
pub async fn persist(st: &Shared, ws: Workspace) -> Result<Workspace, ApiError> {
    let store = st.store.clone();
    let (ws, result) = tokio::task::spawn_blocking(move || {
        let result = store.save_workspace(&ws);
        (ws, result)
    })
    .await
    .map_err(|e| ApiError::internal(format!("store task failed: {e}")))?;
    result?;
    Ok(ws)
}

/// The full application: `/api` routes, live updates, the tool endpoint and the built UI.
pub fn router(st: Shared) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/accept-invite", post(people::accept_invite))
        .route("/me", get(auth::me))
        .route("/invites/lookup", get(people::lookup_invite))
        .route("/members", get(people::list_members))
        .route("/members/{id}", delete(people::delete_member))
        .route(
            "/invites",
            get(people::list_invites).post(people::create_invite),
        )
        .route("/invites/{id}", delete(people::delete_invite))
        .route(
            "/branches",
            get(boards::list_branches).post(history::create_branch),
        )
        .route(
            "/branches/{id}/checkpoints",
            get(history::list_checkpoints).post(history::create_checkpoint),
        )
        .route("/branches/{id}/restore", post(history::restore))
        .route("/branches/{id}/board", get(boards::get_board))
        .route("/branches/{id}/changes", get(boards::get_changes))
        // One maximal `result` of a Run must fit (contract §15); everything else keeps
        // `BODY_LIMIT`.
        .route(
            "/branches/{id}/ops",
            post(boards::post_ops).layer(DefaultBodyLimit::max(boards::OPS_BODY_LIMIT)),
        )
        .route("/merges/plan", get(merges::plan))
        .route("/merges", post(merges::apply))
        .route("/todos", get(todos::list_todos).post(todos::create_todo))
        .route(
            "/todos/{id}",
            patch(todos::patch_todo).delete(todos::delete_todo),
        )
        .route(
            "/tokens",
            get(tokens::list_tokens).post(tokens::create_token),
        )
        .route("/tokens/{id}", delete(tokens::delete_token))
        .route("/suggestions", get(suggestions::list_suggestions))
        .route("/suggestions/{id}/accept", post(suggestions::accept))
        .route("/suggestions/{id}/reject", post(suggestions::reject))
        .route("/suggestions/{id}/reopen", post(suggestions::reopen))
        .route("/ai/status", get(ai::get_status))
        .route("/ai/key", put(ai::put_key).delete(ai::delete_key))
        .route("/ai/model", put(ai::put_model))
        .route("/ai/models", get(ai::get_models))
        .route("/ai/chat", post(chat::chat))
        .route("/sources/lookup", post(sources::lookup))
        .route("/ws", get(live::ws_handler))
        .route("/workspace", get(local::get_workspace));
    // Only a Local Workspace has these; on a Team Workspace they are `404` like any unknown
    // path.
    let api = if st.local.is_some() {
        api.route("/local/enter", get(local::enter))
            .route("/local/member", patch(local::patch_member))
            .route(
                "/local/tutorial",
                get(local::get_tutorial)
                    .put(local::put_tutorial)
                    .layer(DefaultBodyLimit::max(local::TUTORIAL_BODY_LIMIT)),
            )
    } else {
        api
    };
    let api = api
        .fallback(api_not_found)
        .method_not_allowed_fallback(api_not_found)
        .layer(middleware::from_fn_with_state(
            st.clone(),
            auth::resolve_session,
        ));

    let web_dir = st.config.web_dir.clone();
    let ui = ServeDir::new(&web_dir)
        .append_index_html_on_directories(true)
        .fallback(ServeFile::new(web_dir.join("index.html")));

    Router::new()
        .nest("/api", api)
        .route("/visual-frame", get(visual_frame))
        .fallback(move |req: Request| ui_or_not_found(ui.clone(), req))
        .layer(middleware::from_fn_with_state(
            st.clone(),
            auth::origin_guard,
        ))
        // Added after the Origin guard, so that does not wrap it: the tool endpoint is for
        // non-browser clients and has its own rules (bearer token only, no
        // `X-Qoop-Request`, an `Origin` checked only when present). It is also outside
        // `/api`, so the session middleware never runs for it.
        .route("/mcp", post(mcp::post).fallback(mcp::method_not_allowed))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .layer(middleware::from_fn(security_headers))
        .with_state(st)
}

async fn health(State(_): State<Shared>) -> impl IntoResponse {
    axum::Json(json!({ "ok": true }))
}

/// `GET /visual-frame`: public and static, with its own headers instead of the app's CSP.
async fn visual_frame() -> Response {
    let mut res = VISUAL_FRAME.into_response();
    res.extensions_mut().insert(OwnSecurityHeaders);
    let h = res.headers_mut();
    h.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    h.insert(
        CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(VISUAL_FRAME_CSP),
    );
    h.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    h.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    res
}

/// The built UI for every non-`/api` path; anything under `/api` that no route matched
/// (such as `/api/`) is a JSON 404, never `index.html`.
async fn ui_or_not_found(ui: ServeDir<ServeFile>, req: Request) -> Response {
    let path = req.uri().path();
    if path == "/api" || path.starts_with("/api/") {
        return ApiError::NotFound.into_response();
    }
    // Vite names the files under /assets/ after their content, so those may be kept for good.
    let named_by_content = path.starts_with("/assets/");
    let mut res = match ui.oneshot(req).await {
        Ok(res) => res.into_response(),
        Err(never) => match never {},
    };
    // Everything else — above all index.html, which names the current assets — is asked for
    // again each time (a cheap `304` when unchanged): without this a browser, or the desktop
    // app's web view, guesses how long to keep it and goes on showing the UI of before an update.
    let is_html = res
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/html"));
    let keep = if named_by_content && res.status().is_success() && !is_html {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    res.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static(keep));
    res
}

async fn api_not_found() -> ApiError {
    ApiError::NotFound
}

/// `nosniff` and `Referrer-Policy` on everything; the CSP on HTML. The Visual frame sets
/// its own.
async fn security_headers(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    if res.extensions().get::<OwnSecurityHeaders>().is_some() {
        return res;
    }
    let is_html = res
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/html"));
    let h = res.headers_mut();
    h.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(REFERRER_POLICY, HeaderValue::from_static("same-origin"));
    if is_html {
        h.insert(CONTENT_SECURITY_POLICY, HeaderValue::from_static(CSP));
    }
    res
}
