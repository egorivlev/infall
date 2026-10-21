//! Workspace files (docs/specs/portability.md, Contract A; api.md §17): a Local Workspace
//! taken out as one `.infall` file, and a new Local Workspace made from one.
//!
//! A Workspace file is a SQLite database: a consistent copy of the Workspace's own,
//! marked with `PRAGMA application_id = APPLICATION_ID` and carrying its schema version in
//! `PRAGMA user_version` as every database does. Before it leaves the Workspace's folder
//! everything secret or tied to this computer is taken out (see `strip`), and the freed
//! pages are rebuilt away, so not even deleted bytes remain.

use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};

use qoop_core::Workspace;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};

use super::{PRESET_SETTING, Preset, TUTORIAL_SETTING};
use crate::auth::{hash_password, new_token};
use crate::store::SCHEMA_VERSION;

/// The mark of a Workspace file in the SQLite header: "Infa".
pub const APPLICATION_ID: i32 = 0x496e_6661;
/// The extension a Workspace file is given.
pub const WORKSPACE_FILE_EXTENSION: &str = "infall";
/// The settings a Workspace file keeps; every other one is taken out.
const KEPT_SETTINGS: [&str; 2] = [PRESET_SETTING, TUTORIAL_SETTING];
const SQLITE_HEADER: &[u8; 16] = b"SQLite format 3\0";

/// What the start screen needs about a Workspace that was just imported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Imported {
    /// The Preset it was first created from; `None` when the file names one this build
    /// does not know.
    pub preset: Option<Preset>,
}

/// Why an export or an import did not happen. Each is one plain sentence, fit to show as is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortError {
    NotAWorkspaceFile,
    NewerVersion,
    DestinationExists,
    /// The sentence says what could not be read or written.
    Io(String),
}

impl std::fmt::Display for PortError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PortError::NotAWorkspaceFile => f.write_str("This file is not an Infall Workspace file."),
            PortError::NewerVersion => f.write_str(
                "This Workspace file was made by a newer version of Infall. Update Infall to open it.",
            ),
            PortError::DestinationExists => {
                f.write_str("A file with that name is already there. Choose another name.")
            }
            PortError::Io(sentence) => f.write_str(sentence),
        }
    }
}

impl std::error::Error for PortError {}

/// Writes a Workspace file for the database at `db` to `dest` (which must not exist).
/// Safe while the Workspace is open (a consistent snapshot). Secrets and
/// this-computer-only rows are not in the result.
///
/// The copy is made and cleaned beside `db` (the folder that already holds the secrets),
/// and only the clean file is written to `dest`.
pub fn export_workspace(db: &Path, dest: &Path) -> Result<(), PortError> {
    if exists(dest) {
        return Err(PortError::DestinationExists);
    }
    if !db.is_file() {
        return Err(PortError::Io(format!(
            "There is no Workspace database at {}.",
            db.display()
        )));
    }
    let scratch = scratch_path(db)?;
    let result = export_via(db, &scratch, dest);
    remove_quietly(&scratch);
    remove_quietly(&journal_of(&scratch));
    result
}

fn export_via(db: &Path, scratch: &Path, dest: &Path) -> Result<(), PortError> {
    let cannot_read = |e: rusqlite::Error| {
        PortError::Io(format!(
            "The Workspace database {} could not be read: {e}.",
            db.display()
        ))
    };
    // An empty file of our own, private, for `VACUUM INTO` to fill (it takes an empty file).
    create_private(scratch).map_err(|e| {
        PortError::Io(format!(
            "A copy could not be made in {}: {e}.",
            parent_of(scratch).display()
        ))
    })?;
    {
        let source = Connection::open_with_flags(
            db,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(cannot_read)?;
        source
            .busy_timeout(std::time::Duration::from_secs(10))
            .map_err(cannot_read)?;
        let version: i64 = source
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(cannot_read)?;
        if version > SCHEMA_VERSION {
            return Err(PortError::NewerVersion);
        }
        let into = scratch.to_str().ok_or_else(|| {
            PortError::Io("The Workspace's folder has a name Infall cannot use.".to_string())
        })?;
        // One read transaction: a consistent snapshot, even while the server writes.
        source
            .execute("VACUUM INTO ?1", params![into])
            .map_err(cannot_read)?;
    }
    strip(scratch).map_err(|e| PortError::Io(format!("The copy could not be cleaned: {e}.")))?;
    copy_new(scratch, dest).map_err(|e| match e.kind() {
        ErrorKind::AlreadyExists => PortError::DestinationExists,
        _ => PortError::Io(format!(
            "The Workspace file {} could not be written: {e}.",
            dest.display()
        )),
    })
}

/// Takes out of the copy at `path` everything secret or tied to this computer, marks it as
/// a Workspace file, and rebuilds it so that no freed page keeps a deleted byte:
///
/// - every session (`sessions`), invite (`invites`) and access token (`access_tokens`);
/// - every Member's AI settings (`ai_settings`: the sealed OpenRouter key, its nonce, its
///   last four characters, and the chosen model) — the only thing sealed with the secret
///   key, which stays beside the database and is never copied;
/// - every setting but the Preset and the Tutorial's progress;
/// - each Member's password hash, replaced by the hash of a fresh random password nobody
///   knows.
fn strip(path: &Path) -> rusqlite::Result<()> {
    let mut conn = Connection::open(path)?;
    let _mode: String = conn.query_row("PRAGMA journal_mode = DELETE", [], |r| r.get(0))?;
    conn.execute_batch("PRAGMA secure_delete = ON;")?;
    let tx = conn.transaction()?;
    for table in ["sessions", "invites", "access_tokens", "ai_settings"] {
        if has_table(&tx, table)? {
            tx.execute(&format!("DELETE FROM {table}"), [])?;
        }
    }
    if has_table(&tx, "settings")? {
        tx.execute(
            "DELETE FROM settings WHERE name NOT IN (?1, ?2)",
            params![KEPT_SETTINGS[0], KEPT_SETTINGS[1]],
        )?;
    }
    if has_table(&tx, "members")? {
        let ids: Vec<String> = {
            let mut stmt = tx.prepare("SELECT id FROM members")?;
            stmt.query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        for id in ids {
            let fresh = new_token()
                .and_then(|p| hash_password(&p))
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))?;
            tx.execute(
                "UPDATE members SET password_hash = ?1 WHERE id = ?2",
                params![fresh, id],
            )?;
        }
    }
    tx.execute_batch(&format!("PRAGMA application_id = {APPLICATION_ID}"))?;
    tx.commit()?;
    conn.execute_batch("VACUUM")?;
    Ok(())
}

/// Checks that `file` is a Workspace file this version can open, and copies it to `db`
/// (which must not exist). The copy is brought up to the current schema when it is opened
/// by `start_local`. Returns what the start screen needs.
///
/// The copy is checked, not the original, so what was checked is what is opened; when the
/// check fails the copy is removed again and nothing is left at `db`.
pub fn import_workspace(file: &Path, db: &Path) -> Result<Imported, PortError> {
    let mut header = [0u8; 16];
    let read_header = File::open(file).and_then(|mut f| f.read_exact(&mut header));
    match read_header {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::UnexpectedEof => return Err(PortError::NotAWorkspaceFile),
        Err(e) => {
            return Err(PortError::Io(format!(
                "The file {} could not be opened: {e}.",
                file.display()
            )));
        }
    }
    if &header != SQLITE_HEADER {
        return Err(PortError::NotAWorkspaceFile);
    }
    if exists(db) {
        return Err(PortError::DestinationExists);
    }
    if let Some(dir) = db.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(|e| {
            PortError::Io(format!(
                "The folder {} could not be made: {e}.",
                dir.display()
            ))
        })?;
    }
    copy_new(file, db).map_err(|e| match e.kind() {
        ErrorKind::AlreadyExists => PortError::DestinationExists,
        _ => PortError::Io(format!(
            "The Workspace could not be copied to {}: {e}.",
            db.display()
        )),
    })?;
    match check_and_clean(db) {
        Ok(imported) => Ok(imported),
        Err(e) => {
            remove_quietly(db);
            remove_quietly(&journal_of(db));
            Err(e)
        }
    }
}

/// The checks of `import_workspace`, on the copy: the Infall mark, a schema version this
/// build knows, an intact database that is a Local Workspace (a Preset, exactly one
/// Member, an Admin, a Workspace that reads). Then what a file should never bring in —
/// sessions, invites, access tokens, AI settings — is taken out, in case it was made by
/// hand.
fn check_and_clean(db: &Path) -> Result<Imported, PortError> {
    let not_ours = |_: rusqlite::Error| PortError::NotAWorkspaceFile;
    let mut conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(not_ours)?;
    let app_id: i32 = conn
        .query_row("PRAGMA application_id", [], |r| r.get(0))
        .map_err(not_ours)?;
    if app_id != APPLICATION_ID {
        return Err(PortError::NotAWorkspaceFile);
    }
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(not_ours)?;
    if version > SCHEMA_VERSION {
        return Err(PortError::NewerVersion);
    }
    let check: String = conn
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(not_ours)?;
    if check != "ok" {
        return Err(PortError::NotAWorkspaceFile);
    }
    for table in ["members", "workspace", "settings"] {
        if !has_table(&conn, table).map_err(not_ours)? {
            return Err(PortError::NotAWorkspaceFile);
        }
    }
    let preset: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE name = ?1",
            params![PRESET_SETTING],
            |r| r.get(0),
        )
        .optional()
        .map_err(not_ours)?;
    let Some(preset) = preset else {
        // A Team Workspace's database has no Preset.
        return Err(PortError::NotAWorkspaceFile);
    };
    let roles: Vec<String> = {
        let mut stmt = conn.prepare("SELECT role FROM members").map_err(not_ours)?;
        stmt.query_map([], |r| r.get(0))
            .map_err(not_ours)?
            .collect::<rusqlite::Result<_>>()
            .map_err(not_ours)?
    };
    if roles != ["admin"] {
        return Err(PortError::NotAWorkspaceFile);
    }
    let json: Option<String> = conn
        .query_row("SELECT json FROM workspace WHERE id = 1", [], |r| r.get(0))
        .optional()
        .map_err(not_ours)?;
    match json {
        Some(json) if serde_json::from_str::<Workspace>(&json).is_ok() => {}
        _ => return Err(PortError::NotAWorkspaceFile),
    }
    let clean = |e: rusqlite::Error| {
        PortError::Io(format!(
            "The imported Workspace could not be prepared: {e}."
        ))
    };
    let tx = conn.transaction().map_err(clean)?;
    for table in ["sessions", "invites", "access_tokens", "ai_settings"] {
        if has_table(&tx, table).map_err(clean)? {
            tx.execute(&format!("DELETE FROM {table}"), [])
                .map_err(clean)?;
        }
    }
    tx.commit().map_err(clean)?;
    Ok(Imported {
        preset: Preset::from_id(&preset),
    })
}

// ---------------------------------------------------------------- files

fn has_table(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![name],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// Whether anything is at `path`, a dangling link included.
fn exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

fn parent_of(path: &Path) -> &Path {
    path.parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
}

/// `<db>.export-<random>.tmp`, beside `db`.
fn scratch_path(db: &Path) -> Result<PathBuf, PortError> {
    let random = new_token().map_err(|e| PortError::Io(format!("{e}.")))?;
    let mut name = db.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".export-{}.tmp", &random[..12]));
    Ok(db.with_file_name(name))
}

/// The rollback journal SQLite keeps beside a database while it writes.
fn journal_of(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push("-journal");
    path.with_file_name(name)
}

fn remove_quietly(path: &Path) {
    let _ = std::fs::remove_file(path);
}

/// A new, empty file only its owner can open (unix), never one that is already there.
fn create_private(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Copies `from` to `to`, which must not exist (`AlreadyExists` otherwise), and makes sure
/// the bytes are on disk. A half-written `to` is removed again.
fn copy_new(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut source = File::open(from)?;
    let mut target = create_private(to)?;
    let written = std::io::copy(&mut source, &mut target)
        .and_then(|_| target.flush())
        .and_then(|_| target.sync_all());
    if let Err(e) = written {
        drop(target);
        remove_quietly(to);
        return Err(e);
    }
    Ok(())
}
