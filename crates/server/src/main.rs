//! The `qoop-server` command line: `serve` (default), `create-admin`, `reset-password`,
//! `gen-secret-key`.

use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use clap::{Parser, Subcommand};
use qoop_server::config::Config;
use qoop_server::secret::SecretKey;
use qoop_server::store::{SqliteStore, Store};
use qoop_server::{Clock, build_app_with, create_admin, reset_password, serve_until};
use tracing_subscriber::EnvFilter;

/// How long `serve` waits for in-flight requests after a shutdown signal.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

#[derive(Parser)]
#[command(name = "qoop-server", about = "The Infall research workspace server")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the HTTP server (the default).
    Serve,
    /// Create an Admin. The password comes from QOOP_ADMIN_PASSWORD or a prompt.
    CreateAdmin {
        #[arg(long)]
        email: String,
        #[arg(long)]
        name: String,
    },
    /// Set a new password for an account, sign it out everywhere and revoke its access tokens.
    ResetPassword {
        #[arg(long)]
        email: String,
    },
    /// Print a fresh value for QOOP_SECRET_KEY (32 random bytes, base64).
    GenSecretKey,
}

fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    let cli = Cli::parse();
    let command = cli.command.unwrap_or(Command::Serve);
    let result = match Config::from_env() {
        // Needs no configuration, and must work when the configured key is the problem.
        _ if matches!(command, Command::GenSecretKey) => SecretKey::generate().map(|key| {
            println!("{}", key.to_base64());
        }),
        Err(e) => Err(e),
        Ok(config) => match command {
            Command::GenSecretKey => Ok(()),
            Command::Serve => serve(config),
            Command::CreateAdmin { email, name } => open(&config).and_then(|store| {
                let password = read_password()?;
                let m = create_admin(&store, &email, &name, &password, Clock::System.now())
                    .map_err(|e| e.to_string())?;
                println!("Created Admin {} <{}>.", m.name, m.email);
                Ok(())
            }),
            Command::ResetPassword { email } => open(&config).and_then(|store| {
                let password = read_password()?;
                let m = reset_password(&store, &email, &password).map_err(|e| e.to_string())?;
                println!(
                    "Password changed for <{}>; all their sessions were ended and their access tokens revoked.",
                    m.email
                );
                Ok(())
            }),
        },
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("qoop-server: {message}");
            ExitCode::FAILURE
        }
    }
}

fn open(config: &Config) -> Result<SqliteStore, String> {
    SqliteStore::open(&config.db)
        .map_err(|e| format!("cannot open database {}: {e}", config.db.display()))
}

/// `QOOP_ADMIN_PASSWORD` if set, otherwise a no-echo prompt (asked twice).
fn read_password() -> Result<String, String> {
    if let Ok(p) = std::env::var("QOOP_ADMIN_PASSWORD") {
        return Ok(p);
    }
    let first = rpassword::prompt_password("Password (at least 12 characters): ")
        .map_err(|e| format!("cannot read password: {e}"))?;
    let second = rpassword::prompt_password("Repeat password: ")
        .map_err(|e| format!("cannot read password: {e}"))?;
    if first != second {
        return Err("the passwords do not match".to_string());
    }
    Ok(first)
}

fn serve(config: Config) -> Result<(), String> {
    let runtime =
        tokio::runtime::Runtime::new().map_err(|e| format!("cannot start runtime: {e}"))?;
    runtime.block_on(async move {
        let store: Arc<dyn Store> = Arc::new(open(&config)?);
        let addr = config.addr;
        let (app, shutdown) =
            build_app_with(config.clone(), store, Clock::System).map_err(|e| e.to_string())?;
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .map_err(|e| format!("cannot listen on {addr}: {e}"))?;
        tracing::info!(%addr, origin = %config.public_origin, "qoop-server listening");

        let stop = async {
            wait_for_signal().await;
            tracing::info!("shutting down");
        };
        serve_until(listener, app, shutdown, stop, SHUTDOWN_GRACE).await
    })
}

async fn wait_for_signal() {
    let ctrl_c = async {
        if tokio::signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = term => {}
    }
}
