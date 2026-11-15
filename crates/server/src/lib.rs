//! `qoop-server`: accounts, persistence and live updates around `qoop-core`.
//!
//! The contract is `docs/specs/api.md`. `build_app` gives a `Router` that tests can drive
//! without a socket; `main.rs` adds the CLI and the listener.

pub mod ai;
pub mod app;
pub mod auth;
pub mod boards;
pub mod chat;
pub mod comments;
pub mod config;
pub mod error;
pub mod files;
pub mod graph;
pub mod history;
pub mod live;
pub mod local;
pub mod mcp;
pub mod merges;
pub mod people;
pub mod runs;
pub mod scale;
pub mod secret;
pub mod sources;
pub mod store;
pub mod suggestions;
pub mod todos;
pub mod tokens;
pub mod tools;
pub mod transfer;

use std::future::{Future, IntoFuture};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::Router;
use qoop_core::Workspace;
use tokio::sync::{RwLock, Semaphore, watch};

use crate::app::AppState;
use crate::auth::{Throttle, check_new_password, hash_password, new_token, normalize_email};
use crate::config::Config;
use crate::live::Hub;
use crate::people::{clean_email, clean_name, new_member};
use crate::store::{MemberRecord, Role, Store, StoreError};

/// The server's clock, in unix milliseconds. Tests use a manual one.
#[derive(Clone, Debug)]
pub enum Clock {
    System,
    Manual(Arc<AtomicI64>),
}

impl Clock {
    pub fn manual(start_ms: i64) -> Clock {
        Clock::Manual(Arc::new(AtomicI64::new(start_ms)))
    }

    pub fn now(&self) -> i64 {
        match self {
            Clock::System => SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
                .unwrap_or(0),
            Clock::Manual(t) => t.load(Ordering::SeqCst),
        }
    }

    /// Moves a manual clock forward; does nothing to the system clock.
    pub fn advance(&self, ms: i64) {
        if let Clock::Manual(t) = self {
            t.fetch_add(ms, Ordering::SeqCst);
        }
    }
}

/// Why the server could not start.
#[derive(Debug, thiserror::Error)]
pub enum StartError {
    #[error("{0}")]
    Store(#[from] StoreError),
    #[error("{0}")]
    Other(String),
}

/// Lets `serve` tell live connections to close.
pub struct Shutdown(Arc<watch::Sender<bool>>);

impl Shutdown {
    pub fn trigger(&self) {
        let _ = self.0.send(true);
    }
}

/// The application on the system clock.
pub fn build_app(config: Config, store: Arc<dyn Store>) -> Result<Router, StartError> {
    build_app_with(config, store, Clock::System).map(|(router, _)| router)
}

/// The application with a given clock, and its shutdown handle.
///
/// Loads the Workspace from `store`, or creates an empty one and saves it straight away
/// so the id of `main` is stable from the first start.
pub fn build_app_with(
    config: Config,
    store: Arc<dyn Store>,
    clock: Clock,
) -> Result<(Router, Shutdown), StartError> {
    assemble(config, store, clock, None)
}

/// `build_app_with`, for a Team Workspace (`local: None`) or a Local Workspace.
pub(crate) fn assemble(
    config: Config,
    store: Arc<dyn Store>,
    clock: Clock,
    local: Option<local::LocalMode>,
) -> Result<(Router, Shutdown), StartError> {
    let workspace = match store.load_workspace()? {
        Some(ws) => ws,
        None => {
            let (ws, _) = Workspace::new();
            store.save_workspace(&ws)?;
            ws
        }
    };
    let dummy = new_token().map_err(StartError::Other)?;
    let dummy_hash = hash_password(&dummy).map_err(StartError::Other)?;
    let shutdown = Arc::new(watch::Sender::new(false));
    let state = Arc::new(AppState {
        config,
        store,
        workspace: RwLock::new(workspace),
        hub: Hub::default(),
        throttle: Throttle::default(),
        tool_rate: tokens::RateLimit::default(),
        lookup_rate: tokens::RateLimit::new(sources::LOOKUPS_PER_MINUTE),
        pdf_fetch_rate: tokens::RateLimit::new(files::FETCHES_PER_MINUTE),
        ai: ai::AiState::new().map_err(StartError::Other)?,
        clock,
        hashing: Semaphore::new(4),
        dummy_hash,
        shutdown: shutdown.clone(),
        local,
    });
    Ok((app::router(state), Shutdown(shutdown)))
}

/// Serves `app` on `listener` until `stop` finishes, then tells live connections to close
/// and lets in-flight requests finish for at most `grace`.
pub async fn serve_until(
    listener: tokio::net::TcpListener,
    app: Router,
    shutdown: Shutdown,
    stop: impl Future<Output = ()> + Send + 'static,
    grace: Duration,
) -> Result<(), String> {
    let (stopped_tx, stopped_rx) = tokio::sync::oneshot::channel::<()>();
    let server = axum::serve(listener, app).with_graceful_shutdown(async move {
        stop.await;
        shutdown.trigger();
        let _ = stopped_tx.send(());
    });
    let server = server.into_future();
    tokio::pin!(server);
    tokio::select! {
        result = &mut server => return result.map_err(|e| format!("server error: {e}")),
        _ = stopped_rx => {}
    }
    match tokio::time::timeout(grace, server).await {
        Ok(result) => result.map_err(|e| format!("server error: {e}")),
        Err(_) => {
            tracing::warn!("in-flight requests did not finish in time");
            Ok(())
        }
    }
}

/// Why `create-admin` or `reset-password` failed; messages are for the operator.
#[derive(Debug, thiserror::Error)]
pub enum AccountError {
    #[error("{0}")]
    Invalid(String),
    #[error("an account with email {0} already exists")]
    EmailTaken(String),
    #[error("no account has email {0}")]
    UnknownEmail(String),
    #[error("{0}")]
    Store(String),
}

impl From<StoreError> for AccountError {
    fn from(e: StoreError) -> AccountError {
        AccountError::Store(e.to_string())
    }
}

fn invalid(e: error::ApiError) -> AccountError {
    AccountError::Invalid(e.to_string())
}

/// Creates an Admin; refuses an email that exists or a password under 12 characters.
pub fn create_admin(
    store: &dyn Store,
    email: &str,
    name: &str,
    password: &str,
    now: i64,
) -> Result<MemberRecord, AccountError> {
    let email = clean_email(email).map_err(invalid)?;
    let name = clean_name(name).map_err(invalid)?;
    check_new_password(password).map_err(invalid)?;
    if store.member_by_email(&email)?.is_some() {
        return Err(AccountError::EmailTaken(email));
    }
    let phc = hash_password(password).map_err(AccountError::Store)?;
    let m = new_member(
        store,
        Some(email.clone()),
        name,
        Role::Admin,
        None,
        phc,
        now,
    )?;
    match store.insert_member(&m) {
        Ok(()) => Ok(m),
        Err(StoreError::EmailTaken) => Err(AccountError::EmailTaken(email)),
        Err(e) => Err(e.into()),
    }
}

/// Sets a new password for an existing account and deletes all its sessions and access
/// tokens.
pub fn reset_password(
    store: &dyn Store,
    email: &str,
    password: &str,
) -> Result<MemberRecord, AccountError> {
    let email = normalize_email(email);
    check_new_password(password).map_err(invalid)?;
    let m = store
        .member_by_email(&email)?
        .ok_or_else(|| AccountError::UnknownEmail(email.clone()))?;
    let phc = hash_password(password).map_err(AccountError::Store)?;
    if !store.set_password(m.id, &phc)? {
        return Err(AccountError::UnknownEmail(email));
    }
    Ok(m)
}
