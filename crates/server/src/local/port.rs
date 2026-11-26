//! Workspace files (docs/specs/portability.md, Contract A; docs/specs/team-move.md,
//! Contract A; api.md §17 and §19): a Workspace taken out as one `.infall` file, and a
//! Workspace made from one — a new Local Workspace here, or the content of an empty Team
//! Workspace (`prepare_for_team`, used by `crate::transfer`).
//!
//! A Local Workspace's own database, copied by hand, can be imported too (see
//! `import_workspace`).
//!
//! A Workspace file is a SQLite database: a consistent copy of the Workspace's own,
//! marked with `PRAGMA application_id = APPLICATION_ID` and carrying its schema version in
//! `PRAGMA user_version` as every database does. Since schema version 7 it also says, in its
//! `settings`, which kind of Workspace it came from (`file_kind`: `local` or `team`) and who
//! exported it (`exported_by`: a Member id). Before it leaves the Workspace's folder
//! everything secret or tied to this computer is taken out (see `strip_local` and
//! `strip_team`), and the freed pages are rebuilt away, so not even deleted bytes remain.

use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};

use infall_core::{BranchId, MemberId};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};

use super::{LOCAL_EMAIL, PRESET_SETTING, Preset, TUTORIAL_SETTING};
use crate::auth::{hash_password, new_token};
use crate::store::{
    BRANCH_ID_COLUMNS, MEMBER_ID_COLUMNS, MEMBER_ID_IN_TEXT, SCHEMA_VERSION, rename_id, upgrade,
    workspace_in_file,
};

/// The mark of a Workspace file in the SQLite header: "Infa".
pub const APPLICATION_ID: i32 = 0x496e_6661;
/// The extension a Workspace file is given.
pub const WORKSPACE_FILE_EXTENSION: &str = "infall";
/// The setting of a Workspace file that says which kind of Workspace it came from.
pub const KIND_SETTING: &str = "file_kind";
/// The setting of a Workspace file that names the Member who exported it.
pub const EXPORTER_SETTING: &str = "exported_by";
/// Set on a Local Workspace made from a Team file: the first `start_local` gives its one
/// Member the name the desktop app passes (the computer's user's), then forgets it.
pub const RENAME_SETTING: &str = "name_member_on_start";
/// The settings a Local Workspace keeps from its file; every other one is taken out.
const KEPT_SETTINGS: [&str; 2] = [PRESET_SETTING, TUTORIAL_SETTING];
const SQLITE_HEADER: &[u8; 16] = b"SQLite format 3\0";

/// What the start screen needs about a Workspace that was just imported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Imported {
    /// The Preset it was first created from; `None` when the file names one this build
    /// does not know. A Team file becomes a Blank one.
    pub preset: Option<Preset>,
    /// It was a Team Workspace's file (docs/specs/team-move.md, decision 6).
    pub from_team: bool,
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
            PortError::NotAWorkspaceFile => f.write_str(
                "This file is neither an Infall Workspace file nor the database of a Local Workspace.",
            ),
            PortError::NewerVersion => f.write_str(
                "This Workspace was made by a newer version of Infall. Update Infall to open it.",
            ),
            PortError::DestinationExists => {
                f.write_str("A file with that name is already there. Choose another name.")
            }
            PortError::Io(sentence) => f.write_str(sentence),
        }
    }
}

impl std::error::Error for PortError {}

/// Which kind of Workspace a file came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FileKind {
    Local,
    Team,
}

/// What a Workspace file is, as `inspect` found it.
#[derive(Debug, Clone)]
pub(crate) struct Facts {
    pub kind: FileKind,
    /// Whose work it is: a Local Workspace's one Member, or who exported a Team Workspace.
    pub owner: MemberId,
    /// Their name in the file.
    pub owner_name: String,
    pub preset: Option<String>,
}

/// Writes a Workspace file for the database at `db` to `dest` (which must not exist).
/// Safe while the Workspace is open, by this process or another (a consistent snapshot).
/// Secrets and this-computer-only rows are not in the result.
///
/// A Local Workspace's database gives a Local file; any other (a Team Workspace's) a Team
/// file made as decision 5 of docs/specs/team-move.md says, recording its oldest Admin as
/// who exported it.
///
/// The copy is made and cleaned beside `db` (the folder that already holds the secrets),
/// and only the clean file is written to `dest`.
///
/// The stored PDFs and their text go with it (`export_workspace_with` can leave them out).
pub fn export_workspace(db: &Path, dest: &Path) -> Result<(), PortError> {
    export_workspace_with(db, dest, ExportOptions::default())
}

/// What an export takes besides the Workspace itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExportOptions {
    /// The stored PDFs and the text of their pages (docs/specs/pdf-sources.md, decision 6).
    /// Without them the Sources still name their PDFs, and a Workspace made from the file
    /// answers `404 file_missing` for each.
    pub include_files: bool,
}

impl Default for ExportOptions {
    /// Everything: what `export_workspace`, backups and a move take.
    fn default() -> ExportOptions {
        ExportOptions {
            include_files: true,
        }
    }
}

/// `export_workspace`, with or without the stored PDFs (`options`).
pub fn export_workspace_with(
    db: &Path,
    dest: &Path,
    options: ExportOptions,
) -> Result<(), PortError> {
    export_file(db, dest, None, options)
}

/// How many PDFs a Workspace stores, and their bytes in all: what "Include PDFs (N files,
/// X MB)" says before an export. Reads the database at `db` (safe while it is open)
/// without changing it; a database from before PDFs were stored has none.
pub fn file_stats(db: &Path) -> Result<FileStats, PortError> {
    if !db.is_file() {
        return Err(PortError::Io(format!(
            "There is no Workspace database at {}.",
            db.display()
        )));
    }
    let cannot_read = |e: rusqlite::Error| {
        PortError::Io(format!(
            "The Workspace database {} could not be read: {e}.",
            db.display()
        ))
    };
    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(cannot_read)?;
    conn.busy_timeout(std::time::Duration::from_secs(10))
        .map_err(cannot_read)?;
    if !has_table(&conn, "pdf_files").map_err(cannot_read)? {
        return Ok(FileStats { count: 0, bytes: 0 });
    }
    let (count, bytes): (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(size), 0) FROM pdf_files",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(cannot_read)?;
    Ok(FileStats {
        count: count.max(0) as u64,
        bytes: bytes.max(0) as u64,
    })
}

/// What `file_stats` found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FileStats {
    /// How many PDFs are stored.
    pub count: u64,
    /// Their sizes added up.
    pub bytes: u64,
}

/// The Workspace file the desktop app hands to a Team server (docs/specs/team-move.md,
/// Contract A): the same as `export_workspace`, kept as its own name so that a later
/// difference has a place.
pub fn export_for_move(db: &Path, dest: &Path) -> Result<(), PortError> {
    export_workspace(db, dest)
}

/// `export_workspace`, recording `by` as who exported a Team file (`None`: its oldest Admin).
pub(crate) fn export_file(
    db: &Path,
    dest: &Path,
    by: Option<MemberId>,
    options: ExportOptions,
) -> Result<(), PortError> {
    if exists(dest) {
        return Err(PortError::DestinationExists);
    }
    if !db.is_file() {
        return Err(PortError::Io(format!(
            "There is no Workspace database at {}.",
            db.display()
        )));
    }
    let scratch = scratch_path(db, "export")?;
    let result = export_via(db, &scratch, dest, by, options);
    remove_scratch(&scratch);
    result
}

fn export_via(
    db: &Path,
    scratch: &Path,
    dest: &Path,
    by: Option<MemberId>,
    options: ExportOptions,
) -> Result<(), PortError> {
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
        // One read transaction: a consistent snapshot, even while a server writes, in this
        // process or in another.
        source
            .execute("VACUUM INTO ?1", params![into])
            .map_err(cannot_read)?;
    }
    let cleaned = (|| -> rusqlite::Result<()> {
        let mut conn = Connection::open(scratch)?;
        let _mode: String = conn.query_row("PRAGMA journal_mode = DELETE", [], |r| r.get(0))?;
        upgrade(&mut conn).map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))?;
        let local = setting(&conn, PRESET_SETTING)?.is_some();
        drop(conn);
        if local {
            strip_local(scratch, true, options.include_files)
        } else {
            strip_team(scratch, by, options.include_files)
        }
    })();
    cleaned.map_err(|e| PortError::Io(format!("The copy could not be cleaned: {e}.")))?;
    copy_new(scratch, dest).map_err(|e| match e.kind() {
        ErrorKind::AlreadyExists => PortError::DestinationExists,
        _ => PortError::Io(format!(
            "The Workspace file {} could not be written: {e}.",
            dest.display()
        )),
    })
}

/// Takes out of the copy of a Local Workspace at `path` everything secret or tied to this
/// computer, and rebuilds it so that no freed page keeps a deleted byte:
///
/// - every session (`sessions`), invite (`invites`) and access token (`access_tokens`);
/// - every Member's AI settings (`ai_settings`: the sealed OpenRouter key, its nonce, its
///   last four characters, and the chosen model) — the only thing sealed with the secret
///   key, which stays beside the database and is never copied;
/// - every setting but the Preset and the Tutorial's progress;
/// - each Member's password hash, replaced by the hash of a fresh random password nobody
///   knows (a Member who is a name only keeps an empty one).
///
/// With `stamp`, the copy is then marked as a Workspace file of a Local Workspace and names
/// its one Member as who exported it. Without `files`, the stored PDFs and their text are
/// taken out too.
///
/// The stored PDFs are content, not secrets: they carry nothing about who uploaded them or
/// from where, so they stay.
fn strip_local(path: &Path, stamp: bool, files: bool) -> rusqlite::Result<()> {
    let mut conn = Connection::open(path)?;
    let _mode: String = conn.query_row("PRAGMA journal_mode = DELETE", [], |r| r.get(0))?;
    conn.execute_batch("PRAGMA secure_delete = ON;")?;
    let tx = conn.transaction()?;
    delete_secrets(&tx)?;
    if !files {
        delete_files(&tx)?;
    }
    if has_table(&tx, "settings")? {
        tx.execute(
            "DELETE FROM settings WHERE name NOT IN (?1, ?2)",
            params![KEPT_SETTINGS[0], KEPT_SETTINGS[1]],
        )?;
    }
    if has_table(&tx, "members")? {
        let ids: Vec<String> = {
            let mut stmt = tx.prepare("SELECT id FROM members WHERE email IS NOT NULL")?;
            stmt.query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        for id in &ids {
            let fresh = fresh_hash()?;
            tx.execute(
                "UPDATE members SET password_hash = ?1 WHERE id = ?2",
                params![fresh, id],
            )?;
        }
        tx.execute(
            "UPDATE members SET password_hash = '' WHERE email IS NULL",
            [],
        )?;
        if stamp && let [owner] = ids.as_slice() {
            stamp_file(&tx, "local", owner)?;
        }
    }
    tx.execute_batch(&format!("PRAGMA application_id = {APPLICATION_ID}"))?;
    tx.commit()?;
    conn.execute_batch("VACUUM")?;
    Ok(())
}

/// Takes out of the copy of a Team Workspace at `path` what decision 5 of
/// docs/specs/team-move.md lists — sessions, invites, access tokens, AI settings and keys,
/// every setting, and of each Member everything but their name: email, password hash,
/// access time (Guests, who are not Members, go entirely) — marks it as a Team Workspace's
/// file, records who exported it (`by`, else the oldest Admin), and rebuilds it. Without
/// `files`, the stored PDFs and their text are taken out too.
fn strip_team(path: &Path, by: Option<MemberId>, files: bool) -> rusqlite::Result<()> {
    let mut conn = Connection::open(path)?;
    let _mode: String = conn.query_row("PRAGMA journal_mode = DELETE", [], |r| r.get(0))?;
    conn.execute_batch("PRAGMA secure_delete = ON;")?;
    let tx = conn.transaction()?;
    delete_secrets(&tx)?;
    if !files {
        delete_files(&tx)?;
    }
    tx.execute("DELETE FROM settings", [])?;
    let exporter: Option<String> = match by {
        Some(m) => Some(m.0.to_string()),
        None => tx
            .query_row(
                "SELECT id FROM members WHERE role = 'admin' AND email IS NOT NULL
                 ORDER BY created_at, id LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()?,
    };
    tx.execute(
        "DELETE FROM for_you WHERE member IN (SELECT id FROM members WHERE role = 'guest')",
        [],
    )?;
    tx.execute("DELETE FROM members WHERE role = 'guest'", [])?;
    tx.execute(
        "UPDATE members SET email = NULL, password_hash = '', access_until = NULL",
        [],
    )?;
    if let Some(owner) = exporter {
        stamp_file(&tx, "team", &owner)?;
    }
    tx.execute_batch(&format!("PRAGMA application_id = {APPLICATION_ID}"))?;
    tx.commit()?;
    conn.execute_batch("VACUUM")?;
    Ok(())
}

fn stamp_file(conn: &Connection, kind: &str, owner: &str) -> rusqlite::Result<()> {
    for (name, value) in [(KIND_SETTING, kind), (EXPORTER_SETTING, owner)] {
        conn.execute(
            "INSERT INTO settings (name, value) VALUES (?1, ?2)
             ON CONFLICT(name) DO UPDATE SET value = excluded.value",
            params![name, value],
        )?;
    }
    Ok(())
}

/// Sessions, invites, access tokens and AI settings, whichever of them the file has.
fn delete_secrets(conn: &Connection) -> rusqlite::Result<()> {
    for table in ["sessions", "invites", "access_tokens", "ai_settings"] {
        if has_table(conn, table)? {
            conn.execute(&format!("DELETE FROM {table}"), [])?;
        }
    }
    Ok(())
}

/// The stored PDFs and the text of their pages, whichever of them the file has.
fn delete_files(conn: &Connection) -> rusqlite::Result<()> {
    for table in ["pdf_text", "pdf_chunks", "pdf_files"] {
        if has_table(conn, table)? {
            conn.execute(&format!("DELETE FROM {table}"), [])?;
        }
    }
    Ok(())
}

fn fresh_hash() -> rusqlite::Result<String> {
    new_token()
        .and_then(|p| hash_password(&p))
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))
}

fn setting(conn: &Connection, name: &str) -> rusqlite::Result<Option<String>> {
    if !has_table(conn, "settings")? {
        return Ok(None);
    }
    conn.query_row(
        "SELECT value FROM settings WHERE name = ?1",
        params![name],
        |r| r.get(0),
    )
    .optional()
}

/// Checks that `file` is a Workspace file this version can open, and copies it to `db`
/// (which must not exist). The copy is brought up to the current schema when it is opened
/// by `start_local`. Returns what the start screen needs.
///
/// `file` may also be a Local Workspace's own database, copied by hand out of the app's
/// data folder (it has no Workspace-file mark): it passes the same checks, and when a
/// `<file>-wal` lies beside it — the copy was made while the app was running — the Changes
/// kept only there are taken in too. It is then cleaned exactly as an export is.
///
/// A Team Workspace's file (docs/specs/team-move.md, decision 6) becomes a Local Workspace
/// whose one Member is the Member who exported it — named, at the first `start_local`, as
/// that start says — and whose other Members are names only, as they were in the file.
///
/// Neither `file` nor its `-wal` is ever opened as a database, only read as bytes: they are
/// copied beside `db` first, and the copy is what is checked, cleaned and finally written to
/// `db`. When anything fails, the copies are removed and nothing is written to `db`.
pub fn import_workspace(file: &Path, db: &Path) -> Result<Imported, PortError> {
    check_header(file)?;
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
    let scratch = scratch_path(db, "import")?;
    let result = import_via(file, &scratch, db);
    remove_scratch(&scratch);
    // `db` is written last, whole or not at all (`copy_new`), so a failure leaves nothing
    // there.
    result
}

/// `NotAWorkspaceFile` unless `file` starts with the SQLite header.
pub(crate) fn check_header(file: &Path) -> Result<(), PortError> {
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
    Ok(())
}

fn import_via(file: &Path, scratch: &Path, db: &Path) -> Result<Imported, PortError> {
    let not_copied = |e: std::io::Error| {
        PortError::Io(format!(
            "The Workspace could not be copied to {}: {e}.",
            parent_of(scratch).display()
        ))
    };
    copy_new(file, scratch).map_err(not_copied)?;
    let wal = suffixed(file, "-wal");
    if wal.is_file() {
        copy_new(&wal, &suffixed(scratch, "-wal")).map_err(not_copied)?;
    }
    let (marked, facts) = check(scratch)?;
    let from_team = facts.kind == FileKind::Team;
    let preset = if from_team {
        to_local(scratch, facts.owner)?;
        Some(Preset::Blank)
    } else {
        if marked {
            clean(scratch)?;
        } else {
            // A database copied by hand: everything an export takes out is taken out, the
            // `-wal` is folded in, and it is marked, so it is from here on a Workspace file.
            strip_local(scratch, false, true)
                .map_err(|e| PortError::Io(format!("The copy could not be cleaned: {e}.")))?;
        }
        facts.preset.as_deref().and_then(Preset::from_id)
    };
    copy_new(scratch, db).map_err(|e| match e.kind() {
        ErrorKind::AlreadyExists => PortError::DestinationExists,
        _ => PortError::Io(format!(
            "The Workspace could not be copied to {}: {e}.",
            db.display()
        )),
    })?;
    Ok(Imported { preset, from_team })
}

/// Opens the copy at `db` read-write (so that SQLite can read a `-wal` beside the copy and
/// roll back a hot journal: a read-only connection cannot recover either) and inspects it.
fn check(db: &Path) -> Result<(bool, Facts), PortError> {
    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| PortError::NotAWorkspaceFile)?;
    inspect(&conn)
}

/// The checks every Workspace file passes, on the copy: a schema version this build knows,
/// an intact database, a Workspace that reads — from its JSON row in a file older than schema
/// version 6, from its tables in a later one — and either
///
/// - a Local Workspace's (the tables, a Preset, exactly one Member who can sign in, an
///   Admin; any others names only), or
/// - a Team Workspace's file (marked, `file_kind` `team`, and who exported it among its
///   Members).
///
/// Returns whether the copy carries the Workspace-file mark, and what it is.
pub(crate) fn inspect(conn: &Connection) -> Result<(bool, Facts), PortError> {
    let not_ours = |_: rusqlite::Error| PortError::NotAWorkspaceFile;
    let app_id: i32 = conn
        .query_row("PRAGMA application_id", [], |r| r.get(0))
        .map_err(not_ours)?;
    // Unmarked: a Local Workspace's database itself (it is never marked), copied by hand.
    // Marked with anything else: some other program's file.
    let marked = match app_id {
        APPLICATION_ID => true,
        0 => false,
        _ => return Err(PortError::NotAWorkspaceFile),
    };
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
    for table in ["members", "settings"] {
        if !has_table(conn, table).map_err(not_ours)? {
            return Err(PortError::NotAWorkspaceFile);
        }
    }
    let members: Vec<(String, Option<String>, String, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, email, role, name FROM members ORDER BY created_at, id")
            .map_err(not_ours)?;
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .map_err(not_ours)?
            .collect::<rusqlite::Result<_>>()
            .map_err(not_ours)?
    };
    let preset = setting(conn, PRESET_SETTING).map_err(not_ours)?;
    let team = marked && setting(conn, KIND_SETTING).map_err(not_ours)?.as_deref() == Some("team");
    let (owner, owner_name) = if team {
        let exporter = setting(conn, EXPORTER_SETTING).map_err(not_ours)?;
        let Some(found) = members
            .iter()
            .find(|(id, ..)| exporter.as_deref() == Some(id.as_str()))
        else {
            return Err(PortError::NotAWorkspaceFile);
        };
        (found.0.clone(), found.3.clone())
    } else {
        // A Team Workspace's database (or an older Team file) has no Preset.
        if preset.is_none() {
            return Err(PortError::NotAWorkspaceFile);
        }
        let claimed: Vec<_> = members.iter().filter(|m| m.1.is_some()).collect();
        let [one] = claimed.as_slice() else {
            return Err(PortError::NotAWorkspaceFile);
        };
        if one.2 != "admin" {
            return Err(PortError::NotAWorkspaceFile);
        }
        (one.0.clone(), one.3.clone())
    };
    let owner = uuid::Uuid::parse_str(&owner)
        .map(MemberId)
        .map_err(|_| PortError::NotAWorkspaceFile)?;
    // Files from before schema version 6 hold it as one JSON row, later ones in tables.
    if !matches!(workspace_in_file(conn, version), Ok(Some(_))) {
        return Err(PortError::NotAWorkspaceFile);
    }
    Ok((
        marked,
        Facts {
            kind: if team {
                FileKind::Team
            } else {
                FileKind::Local
            },
            owner,
            owner_name,
            preset,
        },
    ))
}

/// What a Workspace file should never bring in — sessions, invites, access tokens, AI
/// settings, settings other than the Preset and the Tutorial's progress — taken out of the
/// copy, in case the file was made by hand.
fn clean(db: &Path) -> Result<(), PortError> {
    let clean = |e: rusqlite::Error| {
        PortError::Io(format!(
            "The imported Workspace could not be prepared: {e}."
        ))
    };
    let mut conn = Connection::open(db).map_err(clean)?;
    // One file, whatever the file it came from used: what is copied to `db` is all of it.
    let _mode: String = conn
        .query_row("PRAGMA journal_mode = DELETE", [], |r| r.get(0))
        .map_err(clean)?;
    let tx = conn.transaction().map_err(clean)?;
    delete_secrets(&tx).map_err(clean)?;
    tx.execute(
        "DELETE FROM settings WHERE name NOT IN (?1, ?2)",
        params![KEPT_SETTINGS[0], KEPT_SETTINGS[1]],
    )
    .map_err(clean)?;
    tx.commit().map_err(clean)?;
    Ok(())
}

/// A Team Workspace's file made into a Local Workspace (docs/specs/team-move.md, decision 6):
/// `owner`, who exported it, becomes the one Member, an Admin who signs in through the
/// desktop app (and is named at the first start); every other Member stays a name only.
fn to_local(db: &Path, owner: MemberId) -> Result<(), PortError> {
    let failed = |e: rusqlite::Error| {
        PortError::Io(format!(
            "The imported Workspace could not be prepared: {e}."
        ))
    };
    let mut conn = Connection::open(db).map_err(failed)?;
    let _mode: String = conn
        .query_row("PRAGMA journal_mode = DELETE", [], |r| r.get(0))
        .map_err(failed)?;
    upgrade(&mut conn)
        .map_err(|e| PortError::Io(format!("The Workspace could not be read: {e}.")))?;
    let owner = owner.0.to_string();
    let fresh = fresh_hash().map_err(failed)?;
    let tx = conn.transaction().map_err(failed)?;
    delete_secrets(&tx).map_err(failed)?;
    tx.execute_batch(
        "DELETE FROM settings;
         DELETE FROM for_you WHERE member IN (SELECT id FROM members WHERE role = 'guest');
         DELETE FROM members WHERE role = 'guest';",
    )
    .map_err(failed)?;
    tx.execute(
        "UPDATE members SET email = NULL, password_hash = '', role = 'member', access_until = NULL
         WHERE id <> ?1",
        params![owner],
    )
    .map_err(failed)?;
    tx.execute(
        "UPDATE members SET email = ?2, password_hash = ?3, role = 'admin', access_until = NULL
         WHERE id = ?1",
        params![owner, LOCAL_EMAIL, fresh],
    )
    .map_err(failed)?;
    for (name, value) in [
        (PRESET_SETTING, Preset::Blank.id()),
        (RENAME_SETTING, owner.as_str()),
    ] {
        tx.execute(
            "INSERT INTO settings (name, value) VALUES (?1, ?2)",
            params![name, value],
        )
        .map_err(failed)?;
    }
    tx.commit().map_err(failed)?;
    Ok(())
}

/// Makes the Workspace file copied to `scratch` ready to be brought into a Team Workspace by
/// `Store::import_prepared` (docs/specs/team-move.md, decisions 2 and 7): checked as
/// `import_workspace` checks, brought to this schema version, stripped of what a file must
/// not bring in, its owner (a Local Workspace's Member, or who exported a Team Workspace's
/// file) made into `admin` everywhere — Changes, Checkpoints, To-dos, Pins, Comments,
/// mentions — and every other Member a name only. Its `main` Branch takes the id of the Team
/// Workspace's (`team_main`), so that those connected stay on it.
pub(crate) fn prepare_for_team(
    scratch: &Path,
    admin: MemberId,
    team_main: Option<BranchId>,
) -> Result<Facts, PortError> {
    check_header(scratch)?;
    let failed = |e: rusqlite::Error| {
        PortError::Io(format!("The Workspace file could not be prepared: {e}."))
    };
    let (_, facts) = check(scratch)?;
    let mut conn = Connection::open(scratch).map_err(|_| PortError::NotAWorkspaceFile)?;
    let _mode: String = conn
        .query_row("PRAGMA journal_mode = DELETE", [], |r| r.get(0))
        .map_err(failed)?;
    // Ids are renamed column by column: the rows refer to each other only once all are done.
    conn.execute_batch("PRAGMA foreign_keys = OFF;")
        .map_err(failed)?;
    upgrade(&mut conn).map_err(|_| PortError::NotAWorkspaceFile)?;
    let tx = conn.transaction().map_err(failed)?;
    delete_secrets(&tx).map_err(failed)?;
    tx.execute_batch(
        "DELETE FROM settings;
         DELETE FROM for_you WHERE member IN (SELECT id FROM members WHERE role = 'guest');
         DELETE FROM members WHERE role = 'guest';",
    )
    .map_err(failed)?;
    let admin = admin.0.to_string();
    rename_id(
        &tx,
        MEMBER_ID_COLUMNS,
        MEMBER_ID_IN_TEXT,
        &facts.owner.0.to_string(),
        &admin,
    )
    .map_err(|e| PortError::Io(format!("The Workspace file could not be prepared: {e}.")))?;
    let file_main: Option<String> = tx
        .query_row(
            "SELECT id FROM branches WHERE parent_branch IS NULL AND name = 'main'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(failed)?;
    if let (Some(from), Some(to)) = (file_main, team_main) {
        rename_id(&tx, BRANCH_ID_COLUMNS, &[], &from, &to.0.to_string()).map_err(|e| {
            PortError::Io(format!("The Workspace file could not be prepared: {e}."))
        })?;
    }
    tx.execute("DELETE FROM members WHERE id = ?1", params![admin])
        .map_err(failed)?;
    tx.execute(
        "UPDATE members SET email = NULL, password_hash = '', role = 'member', access_until = NULL",
        [],
    )
    .map_err(failed)?;
    tx.commit().map_err(failed)?;
    Ok(facts)
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

/// `<db>.<what>-<random>.tmp`, beside `db`.
pub(crate) fn scratch_path(db: &Path, what: &str) -> Result<PathBuf, PortError> {
    let random = new_token().map_err(|e| PortError::Io(format!("{e}.")))?;
    let mut name = db.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{what}-{}.tmp", &random[..12]));
    Ok(db.with_file_name(name))
}

/// Removes a scratch database and whatever SQLite kept beside it.
pub(crate) fn remove_scratch(path: &Path) {
    for leftover in [
        path.to_path_buf(),
        suffixed(path, "-journal"),
        suffixed(path, "-wal"),
        suffixed(path, "-shm"),
    ] {
        remove_quietly(&leftover);
    }
}

/// `path` with `suffix` added to its file name, as SQLite names the files beside a
/// database: `-journal`, `-wal`, `-shm`.
fn suffixed(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

fn remove_quietly(path: &Path) {
    let _ = std::fs::remove_file(path);
}

/// A new, empty file only its owner can open (unix), never one that is already there.
pub(crate) fn create_private(path: &Path) -> std::io::Result<File> {
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
pub(crate) fn copy_new(from: &Path, to: &Path) -> std::io::Result<()> {
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
