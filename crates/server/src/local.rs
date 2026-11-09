//! A Local Workspace: the real server run in-process by the desktop app on `127.0.0.1`, one
//! SQLite file per Workspace, with its one Member signed in through `entry_url`
//! (docs/specs/local.md, Contracts A and B; api.md §16). Workspace files, to take one out
//! and bring one in, are in `port` (docs/specs/portability.md, Contract A; api.md §17).

pub mod port;
pub mod seed;

pub use port::{
    APPLICATION_ID, EXPORTER_SETTING, Imported, KIND_SETTING, PortError, WORKSPACE_FILE_EXTENSION,
    export_for_move, export_workspace, import_workspace,
};

use std::fs::OpenOptions;
use std::io::{ErrorKind, Write};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{RawQuery, State};
use axum::http::header::{CACHE_CONTROL, LOCATION, SET_COOKIE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use qoop_core::{MemberId, Workspace};
use serde::{Deserialize, Serialize};
use serde_json::json;
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::app::{AppState, Shared, blocking};
use crate::auth::{MemberOrAdmin, SignedIn, hash_password, new_token, start_session};
use crate::config::{
    AI_IDLE_TIMEOUT, Config, DEFAULT_ARXIV_URL, DEFAULT_CROSSREF_URL, DEFAULT_OPENROUTER_URL,
    LOOKUP_TIMEOUT,
};
use crate::error::{ApiError, ApiJson};
use crate::people::{clean_name, new_member};
use crate::secret::SecretKey;
use crate::store::{Role, SqliteStore, Store};
use crate::{Clock, Shutdown, StartError, assemble, serve_until};

/// The setting that holds the id of the Preset a Local Workspace was created from.
pub const PRESET_SETTING: &str = "preset";
/// The setting that holds what this Local Workspace's session cookie is called after (see
/// `LocalMode::cookie_name`).
pub const COOKIE_SETTING: &str = "session_cookie";
/// The session cookie of a Local Workspace is called this, followed by its own id.
pub const LOCAL_COOKIE_PREFIX: &str = "qoop_session_";
/// How many characters the id in a Local Workspace's cookie name has.
const COOKIE_ID_CHARS: usize = 16;
/// The setting that holds the Tutorial's progress, as the web UI sent it.
pub const TUTORIAL_SETTING: &str = "tutorial_state";
/// The largest body `PUT /api/local/tutorial` takes.
pub const TUTORIAL_BODY_LIMIT: usize = 16 * 1024;
/// The email of the one Member: `.invalid` is reserved, so no one can receive mail there.
pub const LOCAL_EMAIL: &str = "me@local.invalid";
/// The name the Member gets when the one given is not a usable name.
const FALLBACK_NAME: &str = "Me";
/// How long `stop` lets in-flight requests finish.
const STOP_GRACE: Duration = Duration::from_secs(3);

/// The starting Research Content of a new Local Workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Preset {
    Blank,
    Tutorial,
    LiteratureReview,
    ResearchProject,
}

impl Preset {
    /// Every Preset.
    pub const ALL: [Preset; 4] = [
        Preset::Tutorial,
        Preset::Blank,
        Preset::LiteratureReview,
        Preset::ResearchProject,
    ];

    /// The id used on the wire and in the database.
    pub fn id(&self) -> &'static str {
        match self {
            Preset::Blank => "blank",
            Preset::Tutorial => "tutorial",
            Preset::LiteratureReview => "literature-review",
            Preset::ResearchProject => "research-project",
        }
    }

    pub fn from_id(id: &str) -> Option<Preset> {
        Preset::ALL.into_iter().find(|p| p.id() == id)
    }
}

/// What `start_local` needs.
#[derive(Debug, Clone)]
pub struct LocalOptions {
    /// The Workspace's database; created if absent.
    pub db: PathBuf,
    /// A built `web/dist`.
    pub web_dir: PathBuf,
    /// Used only when `db` is new; ignored afterwards.
    pub preset: Preset,
    /// The one Member's name; used only when `db` is new.
    pub member_name: String,
    /// The port to listen on if it is free, so the Workspace's origin stays the same
    /// between starts. When it is taken or not allowed, and for `None`, the OS chooses one.
    pub port: Option<u16>,
    /// A Workspace that was moved to a Team server (docs/specs/team-move.md, decision 3):
    /// every request that would change anything is refused (`403 moved`); reading, search,
    /// History and exports keep working. `false` for every other Workspace.
    pub read_only: bool,
}

/// The sentence of `403 moved`.
pub const MOVED_SENTENCE: &str =
    "This Workspace was moved to a Team server; open it there to make changes.";

/// What a Local Workspace's server knows that a Team Workspace's does not.
pub struct LocalMode {
    /// The secret of `entry_url`, made at each start.
    key: String,
    /// The one Member, whom `entry_url` signs in.
    member: MemberId,
    /// The name of this Workspace's session cookie.
    cookie: String,
    /// Moved to a Team server: nothing may be changed (`LocalOptions::read_only`).
    pub(crate) read_only: bool,
}

impl LocalMode {
    /// `qoop_session_<id>`, where the id is made at random the first time the Workspace's
    /// database is opened and kept in it (`COOKIE_SETTING`). Every Local Workspace is served
    /// from `127.0.0.1`, and a browser keeps cookies apart by host, not by port: under one
    /// name, opening one Workspace would replace the sign-in of another, and the cookie of
    /// one database would be sent to the server of another. The id is the database's, not
    /// the port's, because a Workspace whose port was taken opens on another one, possibly
    /// one another Workspace had. A Workspace file leaves the id out, so a Workspace
    /// imported from one gets a new id, never its original's.
    pub(crate) fn cookie_name(&self) -> &str {
        &self.cookie
    }
}

/// A running Local Workspace server.
pub struct LocalServer {
    origin: String,
    entry_url: String,
    stop: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<Result<(), String>>>,
}

impl std::fmt::Debug for LocalServer {
    // `entry_url` carries the key, so it is never printed.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalServer")
            .field("origin", &self.origin)
            .finish_non_exhaustive()
    }
}

impl LocalServer {
    /// `http://127.0.0.1:<port>`, the port chosen by the OS.
    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// `<origin>/api/local/enter?key=<secret>`: opening it signs the one Member in.
    pub fn entry_url(&self) -> &str {
        &self.entry_url
    }

    /// Stops listening, closes live connections and lets in-flight requests finish, a few
    /// seconds at most. The key of `entry_url` dies with the server.
    pub async fn stop(mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(mut task) = self.task.take() {
            match tokio::time::timeout(STOP_GRACE + Duration::from_secs(1), &mut task).await {
                Ok(Ok(Err(e))) => tracing::warn!("local server: {e}"),
                Ok(_) => {}
                Err(_) => task.abort(),
            }
        }
    }
}

impl Drop for LocalServer {
    /// A server that is dropped without `stop` is told to stop all the same.
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

/// Opens (or creates and seeds) the Workspace in `options.db` and serves it on `127.0.0.1`,
/// on `options.port` when that is free, else on a port the OS chooses, on the caller's
/// tokio runtime.
pub async fn start_local(options: LocalOptions) -> Result<LocalServer, StartError> {
    let LocalOptions {
        db,
        web_dir,
        preset,
        member_name,
        port,
        read_only,
    } = options;
    let opened = tokio::task::spawn_blocking({
        let db = db.clone();
        move || -> Result<_, StartError> {
            if let Some(dir) = db.parent().filter(|d| !d.as_os_str().is_empty()) {
                std::fs::create_dir_all(dir).map_err(|e| {
                    StartError::Other(format!("cannot create the folder {}: {e}", dir.display()))
                })?;
            }
            let secret_key = load_or_create_secret_key(&secret_key_path(&db))?;
            let store = SqliteStore::open(&db)?;
            Ok((store, secret_key))
        }
    })
    .await
    .map_err(|e| StartError::Other(format!("opening the Workspace failed: {e}")))??;
    let (store, secret_key) = opened;

    let preferred = match port.filter(|p| *p != 0) {
        Some(port) => tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port))
            .await
            .ok(),
        None => None,
    };
    let listener = match preferred {
        Some(listener) => listener,
        None => tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|e| StartError::Other(format!("cannot listen on 127.0.0.1: {e}")))?,
    };
    let addr = listener
        .local_addr()
        .map_err(|e| StartError::Other(format!("cannot read the listening port: {e}")))?;
    let mut config = local_config(addr, web_dir);
    config.db = db;
    config.secret_key = Some(secret_key);
    let origin = config.public_origin.clone();

    let app = tokio::task::spawn_blocking(move || {
        build_local_app_with(
            config,
            Arc::new(store),
            Clock::System,
            preset,
            &member_name,
            read_only,
        )
    })
    .await
    .map_err(|e| StartError::Other(format!("preparing the Workspace failed: {e}")))??;

    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let stop = async move {
        let _ = stop_rx.await;
    };
    let task = tokio::spawn(serve_until(
        listener,
        app.router,
        app.shutdown,
        stop,
        STOP_GRACE,
    ));
    tracing::info!(%origin, "local workspace listening");
    Ok(LocalServer {
        entry_url: format!("{origin}/api/local/enter?key={}", app.entry_key),
        origin,
        stop: Some(stop_tx),
        task: Some(task),
    })
}

/// The configuration of a Local Workspace listening on `addr`: its public origin is
/// `http://127.0.0.1:<port>`, no other origin is allowed, and the OpenRouter path is off
/// until a secret key is set.
pub fn local_config(addr: SocketAddr, web_dir: PathBuf) -> Config {
    Config {
        addr,
        db: PathBuf::from(":memory:"),
        public_origin: format!("http://127.0.0.1:{}", addr.port()),
        dev_origin: None,
        web_dir,
        secret_key: None,
        openrouter_url: DEFAULT_OPENROUTER_URL.to_string(),
        ai_idle_timeout: AI_IDLE_TIMEOUT,
        crossref_url: DEFAULT_CROSSREF_URL.to_string(),
        arxiv_url: DEFAULT_ARXIV_URL.to_string(),
        lookup_timeout: LOOKUP_TIMEOUT,
        max_import_bytes: crate::config::DEFAULT_MAX_IMPORT_MB * 1024 * 1024,
    }
}

/// A Local Workspace application without a socket, and the key its entry takes.
pub struct LocalApp {
    pub router: Router,
    pub shutdown: Shutdown,
    pub entry_key: String,
}

/// Prepares `store` as a Local Workspace and builds its application: what `start_local`
/// does once the database is open, for tests and tools. A store that was never prepared
/// gets the one Member, named `member_name`, and the Research Content of `preset`; one that
/// was keeps what it has.
pub fn build_local_app(
    config: Config,
    store: Arc<dyn Store>,
    clock: Clock,
    preset: Preset,
    member_name: &str,
) -> Result<LocalApp, StartError> {
    build_local_app_with(config, store, clock, preset, member_name, false)
}

/// `build_local_app`, for a Workspace that is read-only (`LocalOptions::read_only`) or not.
pub fn build_local_app_with(
    config: Config,
    store: Arc<dyn Store>,
    clock: Clock,
    preset: Preset,
    member_name: &str,
    read_only: bool,
) -> Result<LocalApp, StartError> {
    let member = prepare(&*store, preset, member_name, clock.now(), read_only)?;
    let cookie = format!("{LOCAL_COOKIE_PREFIX}{}", cookie_id(&*store)?);
    let entry_key = new_token().map_err(StartError::Other)?;
    let local = LocalMode {
        key: entry_key.clone(),
        member,
        cookie,
        read_only,
    };
    let (router, shutdown) = assemble(config, store, clock, Some(local))?;
    Ok(LocalApp {
        router,
        shutdown,
        entry_key,
    })
}

/// The one Member of the store (made if there is none) and, the first time, the Preset's
/// Research Content. The Preset id is written last, so a start that failed half way seeds
/// again next time, unless Changes were already saved.
///
/// The one Member is the Admin who can sign in; a Workspace made from a Team file may also
/// hold Members who are names only. Such a Workspace's first start names its one Member
/// `member_name` (docs/specs/team-move.md, decision 6) — unless it is read-only.
fn prepare(
    store: &dyn Store,
    preset: Preset,
    member_name: &str,
    now: i64,
    read_only: bool,
) -> Result<MemberId, StartError> {
    let existing = store
        .members()?
        .into_iter()
        .find(|m| m.role == Role::Admin && m.claimed());
    let member = match existing {
        Some(m) => {
            if !read_only && store.setting(port::RENAME_SETTING)?.is_some() {
                if let Ok(name) = clean_name(member_name) {
                    store.set_member_name(m.id, &name)?;
                }
                store.remove_setting(port::RENAME_SETTING)?;
            }
            m.id
        }
        None => {
            let name = clean_name(member_name).unwrap_or_else(|_| FALLBACK_NAME.to_string());
            // A password no one knows: signing in with a password is refused here anyway.
            let password = new_token().map_err(StartError::Other)?;
            let phc = hash_password(&password).map_err(StartError::Other)?;
            let m = new_member(
                store,
                Some(LOCAL_EMAIL.to_string()),
                name,
                Role::Admin,
                None,
                phc,
                now,
            )?;
            store.insert_member(&m)?;
            m.id
        }
    };
    if store.setting(PRESET_SETTING)?.is_none() {
        let mut ws = match store.load_workspace()? {
            Some(ws) => ws,
            None => Workspace::new().0,
        };
        let untouched = ws.branches().count() == 1 && ws.branches().all(|b| b.changes().is_empty());
        if untouched {
            let seeded = seed::seed(preset, &mut ws, member, now).map_err(|why| {
                StartError::Other(format!("seeding the {} Preset failed: {why}", preset.id()))
            })?;
            store.save_workspace(&ws)?;
            for todo in &seeded.todos {
                store.insert_todo(todo)?;
            }
            for suggestion in &seeded.suggestions {
                store.insert_suggestion(suggestion)?;
            }
        }
        store.set_setting(PRESET_SETTING, preset.id())?;
    }
    Ok(member)
}

/// The id in the name of this Workspace's session cookie: the one kept in the store, or,
/// when there is none (or what is there is not one this build makes), a new one, kept.
fn cookie_id(store: &dyn Store) -> Result<String, StartError> {
    if let Some(id) = store.setting(COOKIE_SETTING)?.filter(|id| is_cookie_id(id)) {
        return Ok(id);
    }
    let id: String = new_token()
        .map_err(StartError::Other)?
        .chars()
        .take(COOKIE_ID_CHARS)
        .collect();
    store.set_setting(COOKIE_SETTING, &id)?;
    Ok(id)
}

/// URL-safe base64 characters only, all of which a cookie name may hold.
fn is_cookie_id(id: &str) -> bool {
    id.len() == COOKIE_ID_CHARS
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

// ---------------------------------------------------------------- the secret key file

/// Where the secret key of the Workspace in `db` is kept: beside it, named after it.
pub fn secret_key_path(db: &Path) -> PathBuf {
    let mut name = db.file_name().unwrap_or_default().to_os_string();
    name.push(".secret-key");
    db.with_file_name(name)
}

/// Reads the secret key that seals OpenRouter keys at rest, or makes one the first time.
///
/// On unix the file is made readable by its owner only (mode 0600). On Windows it is made
/// like any other file in the app's data folder, which only its user (and the system) can
/// open.
fn load_or_create_secret_key(path: &Path) -> Result<SecretKey, StartError> {
    match std::fs::read_to_string(path) {
        Ok(raw) => SecretKey::from_base64(&raw).map_err(|why| {
            StartError::Other(format!("the secret key file {} {why}", path.display()))
        }),
        Err(e) if e.kind() == ErrorKind::NotFound => {
            let key = SecretKey::generate().map_err(StartError::Other)?;
            write_private(path, key.to_base64().as_bytes()).map_err(|e| {
                StartError::Other(format!(
                    "cannot write the secret key file {}: {e}",
                    path.display()
                ))
            })?;
            Ok(key)
        }
        Err(e) => Err(StartError::Other(format!(
            "cannot read the secret key file {}: {e}",
            path.display()
        ))),
    }
}

fn write_private(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    // `create_new` so that a file someone else made in the meantime is never taken for ours.
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(contents)?;
    file.sync_all()
}

// ---------------------------------------------------------------- the HTTP API

/// Refuses, in a Local Workspace, what exists only for a team.
pub(crate) fn refuse(st: &Shared, why: &'static str) -> Result<(), ApiError> {
    match st.local {
        Some(_) => Err(ApiError::Forbidden(why)),
        None => Ok(()),
    }
}

/// Whether this is a Local Workspace that was moved to a Team server.
pub(crate) fn is_read_only(st: &AppState) -> bool {
    st.local.as_ref().is_some_and(|l| l.read_only)
}

/// Middleware for `/api`: in a moved Workspace, every request that could change anything —
/// whatever is not `GET` or `HEAD`, but for a Source lookup, which only reads — is
/// `403 moved` before any handler runs.
pub(crate) async fn refuse_when_moved(
    State(st): State<Shared>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let reads = matches!(
        *req.method(),
        axum::http::Method::GET | axum::http::Method::HEAD
    ) || matches!(req.uri().path(), "/sources/lookup" | "/api/sources/lookup");
    if is_read_only(&st) && !reads {
        return ApiError::Moved.into_response();
    }
    next.run(req).await
}

/// Whether two keys are the same, in time that does not depend on where they differ.
fn same_key(a: &str, b: &str) -> bool {
    let (a, b) = (Sha256::digest(a.as_bytes()), Sha256::digest(b.as_bytes()));
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

/// `GET /api/workspace`: which kind of Workspace this is, its Preset, whether it is empty
/// (a Team Workspace that a Workspace file may be brought into, docs/specs/team-move.md,
/// decision 1) and whether it is read-only (a moved Local Workspace).
pub async fn get_workspace(State(st): State<Shared>, _: SignedIn) -> Result<Response, ApiError> {
    if st.local.is_none() {
        let empty = crate::transfer::is_empty(&st).await?;
        return Ok(Json(json!({
            "kind": "team", "preset": null, "empty": empty, "read_only": false,
        }))
        .into_response());
    }
    let preset = blocking(&st, |s| s.setting(PRESET_SETTING)).await?;
    Ok(Json(json!({
        "kind": "local", "preset": preset, "empty": false, "read_only": is_read_only(&st),
    }))
    .into_response())
}

/// `GET /api/local/enter?key=…`: with the key of this start, a session for the one Member
/// and `303` to `/`; anything else is `404`.
pub async fn enter(State(st): State<Shared>, RawQuery(query): RawQuery) -> Response {
    let Some(local) = &st.local else {
        return ApiError::NotFound.into_response();
    };
    let given = query.as_deref().unwrap_or("").split('&').find_map(|pair| {
        pair.split_once('=')
            .filter(|(name, _)| *name == "key")
            .map(|(_, v)| v)
    });
    if !given.is_some_and(|k| same_key(k, &local.key)) {
        return ApiError::NotFound.into_response();
    }
    match start_session(&st, local.member).await {
        Ok(cookie) => (
            StatusCode::SEE_OTHER,
            [
                (SET_COOKIE, cookie),
                (LOCATION, HeaderValue::from_static("/")),
                (CACHE_CONTROL, HeaderValue::from_static("no-store")),
            ],
        )
            .into_response(),
        Err(e) => e.into_response(),
    }
}

#[derive(Deserialize)]
pub struct NameBody {
    name: String,
}

/// `PATCH /api/local/member`: the one Member's new name.
pub async fn patch_member(
    State(st): State<Shared>,
    MemberOrAdmin(who): MemberOrAdmin,
    ApiJson(body): ApiJson<NameBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let name = clean_name(&body.name)?;
    let id = who.id();
    let stored = {
        let name = name.clone();
        blocking(&st, move |s| s.set_member_name(id, &name)).await?
    };
    if !stored {
        return Err(ApiError::NotFound);
    }
    Ok(Json(json!({ "name": name })))
}

/// The body of `GET /api/local/tutorial`.
#[derive(Serialize)]
pub struct TutorialView {
    state: Option<Box<RawValue>>,
}

/// `GET /api/local/tutorial`: the Tutorial's progress, exactly as last stored, or null.
pub async fn get_tutorial(
    State(st): State<Shared>,
    MemberOrAdmin(_): MemberOrAdmin,
) -> Result<Json<TutorialView>, ApiError> {
    let stored = blocking(&st, |s| s.setting(TUTORIAL_SETTING)).await?;
    let state = match stored {
        Some(raw) => Some(RawValue::from_string(raw).map_err(ApiError::internal)?),
        None => None,
    };
    Ok(Json(TutorialView { state }))
}

#[derive(Deserialize)]
pub struct TutorialBody {
    state: Box<RawValue>,
}

/// `PUT /api/local/tutorial`: stores the Tutorial's progress as it came, without reading it.
pub async fn put_tutorial(
    State(st): State<Shared>,
    MemberOrAdmin(_): MemberOrAdmin,
    ApiJson(body): ApiJson<TutorialBody>,
) -> Result<StatusCode, ApiError> {
    let raw = body.state.get().to_string();
    blocking(&st, move |s| s.set_setting(TUTORIAL_SETTING, &raw)).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preset_ids_go_both_ways() {
        for p in Preset::ALL {
            assert_eq!(Preset::from_id(p.id()), Some(p));
        }
        assert_eq!(Preset::from_id("Tutorial"), None);
        assert_eq!(Preset::from_id(""), None);
        assert_eq!(Preset::LiteratureReview.id(), "literature-review");
    }

    #[test]
    fn cookie_ids_are_kept_and_made_again_only_when_unusable() {
        let store = crate::store::MemoryStore::new();
        let first = cookie_id(&store).unwrap();
        assert!(is_cookie_id(&first), "{first}");
        assert_eq!(cookie_id(&store).unwrap(), first);
        for bad in [
            "",
            "short",
            "has a space in it",
            "semi;colon=equals",
            "ééééééééé",
        ] {
            store.set_setting(COOKIE_SETTING, bad).unwrap();
            let made = cookie_id(&store).unwrap();
            assert!(is_cookie_id(&made), "{bad}");
            assert_eq!(store.setting(COOKIE_SETTING).unwrap(), Some(made));
        }
        assert_ne!(cookie_id(&crate::store::MemoryStore::new()).unwrap(), first);
    }

    #[test]
    fn keys_are_compared_whole() {
        assert!(same_key("abc", "abc"));
        assert!(!same_key("abc", "abd"));
        assert!(!same_key("abc", "ab"));
        assert!(!same_key("", "abc"));
    }

    #[test]
    fn the_secret_key_file_sits_beside_the_database() {
        assert_eq!(
            secret_key_path(Path::new("/data/ws/workspace.db")),
            PathBuf::from("/data/ws/workspace.db.secret-key")
        );
    }
}
