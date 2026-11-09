//! Large Workspaces for measuring Infall at size (docs/specs/scale.md).
//!
//! ```text
//! cargo run --release -p qoop-server --example big_workspace -- generate --out big.db --file big.infall
//! cargo run --release -p qoop-server --example big_workspace -- serve --db big.db --web web/dist
//! cargo run --release -p qoop-server --example big_workspace -- measure --db big.db --web web/dist
//! ```

use std::path::PathBuf;

use clap::{Parser, Subcommand};
use qoop_core::BranchId;
use qoop_server::local::{LocalOptions, Preset, export_workspace, start_local};
use qoop_server::scale::{Size, generate, measure};
use qoop_server::store::{SqliteStore, Store};

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Writes a new Local Workspace database, and optionally a Workspace file of it.
    Generate {
        #[arg(long, default_value_t = 2000)]
        cards: usize,
        #[arg(long, default_value_t = 6000)]
        connections: usize,
        #[arg(long, default_value_t = 200)]
        pages: usize,
        #[arg(long, default_value_t = 3)]
        long_pages: usize,
        #[arg(long, default_value_t = 50)]
        screens: usize,
        #[arg(long, default_value_t = 50_000)]
        changes: usize,
        #[arg(long, default_value_t = 12)]
        branches: usize,
        #[arg(long, default_value_t = 60)]
        todos: usize,
        #[arg(long, default_value_t = 1)]
        seed: u64,
        /// The database to write; must not exist.
        #[arg(long)]
        out: PathBuf,
        /// Also a Workspace file (`.infall`) for the desktop app's Import.
        #[arg(long)]
        file: Option<PathBuf>,
    },
    /// Serves a Local Workspace database on 127.0.0.1 until Ctrl+C, printing its entry URL.
    Serve {
        #[arg(long)]
        db: PathBuf,
        #[arg(long)]
        web: PathBuf,
        #[arg(long)]
        port: Option<u16>,
    },
    /// Times what the web UI asks of the server, on a copy of the database.
    Measure {
        #[arg(long)]
        db: PathBuf,
        #[arg(long)]
        web: PathBuf,
        /// Where the copies go; defaults to beside the database.
        #[arg(long)]
        scratch: Option<PathBuf>,
        #[arg(long, default_value_t = 20)]
        edits: usize,
    },
}

#[tokio::main]
async fn main() -> Result<(), String> {
    match Cli::parse().command {
        Command::Generate {
            cards,
            connections,
            pages,
            long_pages,
            screens,
            changes,
            branches,
            todos,
            seed,
            out,
            file,
        } => {
            let size = Size {
                cards,
                connections,
                pages,
                long_pages,
                long_page_screens: screens,
                changes,
                branches,
                todos,
                seed,
            };
            let made = tokio::task::spawn_blocking(move || generate(&size, &out).map(|g| (g, out)))
                .await
                .map_err(|e| e.to_string())??;
            let (g, out) = made;
            println!("{g:#?}");
            if let Some(file) = file {
                export_workspace(&out, &file).map_err(|e| e.to_string())?;
                println!("Workspace file: {}", file.display());
            }
        }
        Command::Serve { db, web, port } => {
            let server = start_local(LocalOptions {
                db,
                web_dir: web,
                preset: Preset::Blank,
                member_name: "Scale Test".to_string(),
                port,
            })
            .await
            .map_err(|e| e.to_string())?;
            println!("{}", server.entry_url());
            tokio::signal::ctrl_c().await.map_err(|e| e.to_string())?;
            server.stop().await;
        }
        Command::Measure {
            db,
            web,
            scratch,
            edits,
        } => {
            let scratch = scratch
                .or_else(|| db.parent().map(PathBuf::from))
                .unwrap_or_else(|| PathBuf::from("."));
            // A database of an older schema is migrated here, in place, and timed.
            let t = std::time::Instant::now();
            drop(SqliteStore::open(&db).map_err(|e| e.to_string())?);
            println!(
                "opened the database (migrating it if older) in {:?}",
                t.elapsed()
            );
            let open = largest_open_branch(&db)?;
            profile(&db)?;
            let m = measure(&db, &web, &scratch, open, edits).await?;
            println!("{m:#?}");
        }
    }
    Ok(())
}

/// The Branch with the most Changes that was never merged, read from the database.
fn largest_open_branch(db: &std::path::Path) -> Result<Option<BranchId>, String> {
    let store = SqliteStore::open(db).map_err(|e| e.to_string())?;
    let ws = store
        .load_workspace()
        .map_err(|e| e.to_string())?
        .ok_or("the database holds no Workspace")?;
    Ok(ws
        .branches()
        .filter(|b| b.parent().is_some())
        .filter(|b| b.sync_points().iter().all(|p| p.landed.is_none()))
        .max_by_key(|b| b.changes().len())
        .map(|b| b.id()))
}

/// Where the time goes, in this process: reading the Workspace from the database (what a
/// start does), replaying `main`, and the copies the server makes of the Workspace for each
/// edit and of a Board.
fn profile(db: &std::path::Path) -> Result<(), String> {
    use std::time::Instant;
    let t = Instant::now();
    let store = SqliteStore::open(db).map_err(|e| e.to_string())?;
    let ws = store
        .load_workspace()
        .map_err(|e| e.to_string())?
        .ok_or("the database holds no Workspace")?;
    let load = t.elapsed();
    let main = ws.branch_by_name("main").ok_or("no main")?.id();
    let t = Instant::now();
    let board = ws
        .board_at(ws.head(main).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let replay = t.elapsed();
    let t = Instant::now();
    let _copy = ws.clone();
    let clone = t.elapsed();
    let t = Instant::now();
    let _ = board.clone();
    let board_clone = t.elapsed();
    println!(
        "open and read the Workspace {load:?}, replay main {replay:?}, clone Workspace {clone:?}, clone Board {board_clone:?}"
    );
    Ok(())
}
