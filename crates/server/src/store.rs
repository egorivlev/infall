//! Persistence: the `Store` trait, its SQLite implementation and an in-memory one for tests.
//!
//! Every method is blocking; async callers go through `tokio::task::spawn_blocking`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use qoop_core::{MemberId, Workspace};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// What a person may do (contract §3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Admin,
    Member,
    Guest,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Admin => "admin",
            Role::Member => "member",
            Role::Guest => "guest",
        }
    }

    fn parse(s: &str) -> Option<Role> {
        match s {
            "admin" => Some(Role::Admin),
            "member" => Some(Role::Member),
            "guest" => Some(Role::Guest),
            _ => None,
        }
    }
}

/// A stored account.
#[derive(Debug, Clone, PartialEq)]
pub struct MemberRecord {
    pub id: MemberId,
    /// Trimmed and lowercased.
    pub email: String,
    pub name: String,
    pub role: Role,
    pub color: String,
    /// Argon2id PHC string.
    pub password_hash: String,
    /// Unix ms; guests only.
    pub access_until: Option<i64>,
    pub created_at: i64,
}

/// A stored invite. Only the SHA-256 of its token is kept.
#[derive(Debug, Clone, PartialEq)]
pub struct InviteRecord {
    pub id: Uuid,
    pub token_hash: String,
    pub email: String,
    pub role: Role,
    pub access_until: Option<i64>,
    pub expires_at: i64,
    pub created_by: MemberId,
    pub created_at: i64,
    pub used_at: Option<i64>,
}

impl InviteRecord {
    pub fn is_pending(&self, now: i64) -> bool {
        self.used_at.is_none() && self.expires_at > now
    }
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum StoreError {
    #[error("an account with that email already exists")]
    EmailTaken,
    #[error("the invite is expired, used or gone")]
    InviteGone,
    #[error("storage failure: {0}")]
    Backend(String),
}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> StoreError {
        StoreError::Backend(e.to_string())
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(e: serde_json::Error) -> StoreError {
        StoreError::Backend(format!("workspace JSON: {e}"))
    }
}

pub type StoreResult<T> = Result<T, StoreError>;

/// Accounts, sessions, invites and the Workspace snapshot.
pub trait Store: Send + Sync + 'static {
    fn load_workspace(&self) -> StoreResult<Option<Workspace>>;
    /// Replaces the snapshot atomically.
    fn save_workspace(&self, ws: &Workspace) -> StoreResult<()>;

    /// `EmailTaken` if the email is in use.
    fn insert_member(&self, m: &MemberRecord) -> StoreResult<()>;
    fn member(&self, id: MemberId) -> StoreResult<Option<MemberRecord>>;
    fn member_by_email(&self, email: &str) -> StoreResult<Option<MemberRecord>>;
    /// Ordered by creation time.
    fn members(&self) -> StoreResult<Vec<MemberRecord>>;
    fn member_count(&self) -> StoreResult<usize>;
    /// Removes the account and all its sessions; false if there was none.
    fn delete_member(&self, id: MemberId) -> StoreResult<bool>;
    /// Sets a new password hash and deletes all the account's sessions; false if unknown.
    fn set_password(&self, id: MemberId, password_hash: &str) -> StoreResult<bool>;

    fn insert_session(
        &self,
        token_hash: &str,
        member: MemberId,
        expires_at: i64,
        now: i64,
    ) -> StoreResult<()>;
    /// The live session's member and expiry; expired sessions are not returned.
    fn session(&self, token_hash: &str, now: i64) -> StoreResult<Option<(MemberRecord, i64)>>;
    fn extend_session(&self, token_hash: &str, expires_at: i64) -> StoreResult<()>;
    fn delete_session(&self, token_hash: &str) -> StoreResult<()>;

    fn insert_invite(&self, invite: &InviteRecord) -> StoreResult<()>;
    fn invite_by_token_hash(&self, token_hash: &str) -> StoreResult<Option<InviteRecord>>;
    /// Unused and unexpired, ordered by creation time.
    fn pending_invites(&self, now: i64) -> StoreResult<Vec<InviteRecord>>;
    /// Deletes a pending invite; false if there was none.
    fn delete_invite(&self, id: Uuid, now: i64) -> StoreResult<bool>;
    /// Atomically marks the invite used (it must still be pending: else `InviteGone`) and
    /// creates the account (`EmailTaken` if the email is in use; then the invite stays unused).
    fn accept_invite(&self, invite: Uuid, member: &MemberRecord, now: i64) -> StoreResult<()>;
}

// ---------------------------------------------------------------- SQLite

/// The schema version this binary writes; kept in `PRAGMA user_version`.
pub const SCHEMA_VERSION: i64 = 1;

const SCHEMA_V1: &str = "
CREATE TABLE members (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    color TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    access_until INTEGER,
    created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX sessions_member ON sessions(member_id);
CREATE TABLE invites (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    access_until INTEGER,
    expires_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    used_at INTEGER
);
CREATE TABLE workspace (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    json TEXT NOT NULL
);
";

/// Steps that bring a file from version `i` to `i + 1`; index 0 creates the schema.
/// A later version appends its step here.
const MIGRATIONS: &[&str] = &[SCHEMA_V1];

/// The SQLite store: one connection behind a mutex.
pub struct SqliteStore {
    conn: Mutex<Connection>,
}

impl SqliteStore {
    /// Opens (creating if needed) and migrates the database file.
    pub fn open(path: &Path) -> StoreResult<SqliteStore> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    /// A private in-memory SQLite database (tests).
    pub fn open_in_memory() -> StoreResult<SqliteStore> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> StoreResult<SqliteStore> {
        // `journal_mode` returns a row, so it is read rather than executed.
        let _mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
        conn.execute_batch(
            "PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
        )?;
        migrate(&mut conn)?;
        Ok(SqliteStore {
            conn: Mutex::new(conn),
        })
    }

    fn conn(&self) -> StoreResult<MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| StoreError::Backend("database lock poisoned".to_string()))
    }
}

/// Runs every migration step past the file's `user_version`, each in its own transaction.
fn migrate(conn: &mut Connection) -> StoreResult<()> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if current > SCHEMA_VERSION {
        return Err(StoreError::Backend(format!(
            "database schema version {current} is newer than this binary ({SCHEMA_VERSION})"
        )));
    }
    for (step, sql) in MIGRATIONS.iter().enumerate().skip(current.max(0) as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        // PRAGMA cannot take bound parameters; the value is our own integer.
        tx.execute_batch(&format!("PRAGMA user_version = {}", step + 1))?;
        tx.commit()?;
    }
    Ok(())
}

fn parse_uuid(s: &str) -> rusqlite::Result<Uuid> {
    Uuid::parse_str(s).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn parse_role(s: &str) -> rusqlite::Result<Role> {
    Role::parse(s).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            format!("unknown role {s:?}").into(),
        )
    })
}

const MEMBER_COLS: &str = "id, email, name, role, color, password_hash, access_until, created_at";

fn member_row(r: &Row<'_>) -> rusqlite::Result<MemberRecord> {
    Ok(MemberRecord {
        id: MemberId(parse_uuid(&r.get::<_, String>(0)?)?),
        email: r.get(1)?,
        name: r.get(2)?,
        role: parse_role(&r.get::<_, String>(3)?)?,
        color: r.get(4)?,
        password_hash: r.get(5)?,
        access_until: r.get(6)?,
        created_at: r.get(7)?,
    })
}

const INVITE_COLS: &str =
    "id, token_hash, email, role, access_until, expires_at, created_by, created_at, used_at";

fn invite_row(r: &Row<'_>) -> rusqlite::Result<InviteRecord> {
    Ok(InviteRecord {
        id: parse_uuid(&r.get::<_, String>(0)?)?,
        token_hash: r.get(1)?,
        email: r.get(2)?,
        role: parse_role(&r.get::<_, String>(3)?)?,
        access_until: r.get(4)?,
        expires_at: r.get(5)?,
        created_by: MemberId(parse_uuid(&r.get::<_, String>(6)?)?),
        created_at: r.get(7)?,
        used_at: r.get(8)?,
    })
}

fn is_unique_violation(e: &rusqlite::Error) -> bool {
    matches!(
        e,
        rusqlite::Error::SqliteFailure(f, _)
            if f.code == rusqlite::ErrorCode::ConstraintViolation
    )
}

fn insert_member_on(conn: &Connection, m: &MemberRecord) -> StoreResult<()> {
    let sql =
        format!("INSERT INTO members ({MEMBER_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)");
    conn.execute(
        &sql,
        params![
            m.id.0.to_string(),
            m.email,
            m.name,
            m.role.as_str(),
            m.color,
            m.password_hash,
            m.access_until,
            m.created_at
        ],
    )
    .map_err(|e| {
        if is_unique_violation(&e) {
            StoreError::EmailTaken
        } else {
            e.into()
        }
    })?;
    Ok(())
}

impl Store for SqliteStore {
    fn load_workspace(&self) -> StoreResult<Option<Workspace>> {
        let conn = self.conn()?;
        let json: Option<String> = conn
            .query_row("SELECT json FROM workspace WHERE id = 1", [], |r| r.get(0))
            .optional()?;
        Ok(match json {
            Some(j) => Some(serde_json::from_str(&j)?),
            None => None,
        })
    }

    fn save_workspace(&self, ws: &Workspace) -> StoreResult<()> {
        let json = serde_json::to_string(ws)?;
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO workspace (id, json) VALUES (1, ?1)
             ON CONFLICT(id) DO UPDATE SET json = excluded.json",
            params![json],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn insert_member(&self, m: &MemberRecord) -> StoreResult<()> {
        insert_member_on(&*self.conn()?, m)
    }

    fn member(&self, id: MemberId) -> StoreResult<Option<MemberRecord>> {
        let sql = format!("SELECT {MEMBER_COLS} FROM members WHERE id = ?1");
        Ok(self
            .conn()?
            .query_row(&sql, params![id.0.to_string()], member_row)
            .optional()?)
    }

    fn member_by_email(&self, email: &str) -> StoreResult<Option<MemberRecord>> {
        let sql = format!("SELECT {MEMBER_COLS} FROM members WHERE email = ?1");
        Ok(self
            .conn()?
            .query_row(&sql, params![email], member_row)
            .optional()?)
    }

    fn members(&self) -> StoreResult<Vec<MemberRecord>> {
        let conn = self.conn()?;
        let sql = format!("SELECT {MEMBER_COLS} FROM members ORDER BY created_at, id");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], member_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    fn member_count(&self) -> StoreResult<usize> {
        let n: i64 = self
            .conn()?
            .query_row("SELECT COUNT(*) FROM members", [], |r| r.get(0))?;
        Ok(usize::try_from(n).unwrap_or(0))
    }

    fn delete_member(&self, id: MemberId) -> StoreResult<bool> {
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let id = id.0.to_string();
        tx.execute("DELETE FROM sessions WHERE member_id = ?1", params![id])?;
        let n = tx.execute("DELETE FROM members WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(n > 0)
    }

    fn set_password(&self, id: MemberId, password_hash: &str) -> StoreResult<bool> {
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let id = id.0.to_string();
        let n = tx.execute(
            "UPDATE members SET password_hash = ?1 WHERE id = ?2",
            params![password_hash, id],
        )?;
        tx.execute("DELETE FROM sessions WHERE member_id = ?1", params![id])?;
        tx.commit()?;
        Ok(n > 0)
    }

    fn insert_session(
        &self,
        token_hash: &str,
        member: MemberId,
        expires_at: i64,
        now: i64,
    ) -> StoreResult<()> {
        let conn = self.conn()?;
        conn.execute("DELETE FROM sessions WHERE expires_at <= ?1", params![now])?;
        conn.execute(
            "INSERT INTO sessions (token_hash, member_id, expires_at, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![token_hash, member.0.to_string(), expires_at, now],
        )?;
        Ok(())
    }

    fn session(&self, token_hash: &str, now: i64) -> StoreResult<Option<(MemberRecord, i64)>> {
        let cols = MEMBER_COLS
            .split(", ")
            .map(|c| format!("m.{c}"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT {cols}, s.expires_at FROM sessions s JOIN members m ON m.id = s.member_id
             WHERE s.token_hash = ?1 AND s.expires_at > ?2"
        );
        Ok(self
            .conn()?
            .query_row(&sql, params![token_hash, now], |r| {
                Ok((member_row(r)?, r.get::<_, i64>(8)?))
            })
            .optional()?)
    }

    fn extend_session(&self, token_hash: &str, expires_at: i64) -> StoreResult<()> {
        self.conn()?.execute(
            "UPDATE sessions SET expires_at = ?1 WHERE token_hash = ?2",
            params![expires_at, token_hash],
        )?;
        Ok(())
    }

    fn delete_session(&self, token_hash: &str) -> StoreResult<()> {
        self.conn()?.execute(
            "DELETE FROM sessions WHERE token_hash = ?1",
            params![token_hash],
        )?;
        Ok(())
    }

    fn insert_invite(&self, i: &InviteRecord) -> StoreResult<()> {
        let sql = format!(
            "INSERT INTO invites ({INVITE_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
        );
        self.conn()?.execute(
            &sql,
            params![
                i.id.to_string(),
                i.token_hash,
                i.email,
                i.role.as_str(),
                i.access_until,
                i.expires_at,
                i.created_by.0.to_string(),
                i.created_at,
                i.used_at
            ],
        )?;
        Ok(())
    }

    fn invite_by_token_hash(&self, token_hash: &str) -> StoreResult<Option<InviteRecord>> {
        let sql = format!("SELECT {INVITE_COLS} FROM invites WHERE token_hash = ?1");
        Ok(self
            .conn()?
            .query_row(&sql, params![token_hash], invite_row)
            .optional()?)
    }

    fn pending_invites(&self, now: i64) -> StoreResult<Vec<InviteRecord>> {
        let conn = self.conn()?;
        let sql = format!(
            "SELECT {INVITE_COLS} FROM invites WHERE used_at IS NULL AND expires_at > ?1
             ORDER BY created_at, id"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![now], invite_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    fn delete_invite(&self, id: Uuid, now: i64) -> StoreResult<bool> {
        let n = self.conn()?.execute(
            "DELETE FROM invites WHERE id = ?1 AND used_at IS NULL AND expires_at > ?2",
            params![id.to_string(), now],
        )?;
        Ok(n > 0)
    }

    fn accept_invite(&self, invite: Uuid, member: &MemberRecord, now: i64) -> StoreResult<()> {
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let used = tx.execute(
            "UPDATE invites SET used_at = ?1
             WHERE id = ?2 AND used_at IS NULL AND expires_at > ?1",
            params![now, invite.to_string()],
        )?;
        if used == 0 {
            return Err(StoreError::InviteGone);
        }
        insert_member_on(&tx, member)?;
        tx.commit()?;
        Ok(())
    }
}

// ---------------------------------------------------------------- memory

#[derive(Default)]
struct Memory {
    workspace: Option<Workspace>,
    members: Vec<MemberRecord>,
    sessions: HashMap<String, (MemberId, i64)>,
    invites: Vec<InviteRecord>,
}

/// An in-memory store with the same rules as SQLite (tests).
#[derive(Default)]
pub struct MemoryStore {
    inner: Mutex<Memory>,
}

impl MemoryStore {
    pub fn new() -> MemoryStore {
        MemoryStore::default()
    }

    fn lock(&self) -> StoreResult<MutexGuard<'_, Memory>> {
        self.inner
            .lock()
            .map_err(|_| StoreError::Backend("memory store lock poisoned".to_string()))
    }
}

impl Memory {
    fn insert_member(&mut self, m: &MemberRecord) -> StoreResult<()> {
        if self.members.iter().any(|x| x.email == m.email) {
            return Err(StoreError::EmailTaken);
        }
        self.members.push(m.clone());
        Ok(())
    }
}

impl Store for MemoryStore {
    fn load_workspace(&self) -> StoreResult<Option<Workspace>> {
        Ok(self.lock()?.workspace.clone())
    }

    fn save_workspace(&self, ws: &Workspace) -> StoreResult<()> {
        self.lock()?.workspace = Some(ws.clone());
        Ok(())
    }

    fn insert_member(&self, m: &MemberRecord) -> StoreResult<()> {
        self.lock()?.insert_member(m)
    }

    fn member(&self, id: MemberId) -> StoreResult<Option<MemberRecord>> {
        Ok(self.lock()?.members.iter().find(|m| m.id == id).cloned())
    }

    fn member_by_email(&self, email: &str) -> StoreResult<Option<MemberRecord>> {
        Ok(self
            .lock()?
            .members
            .iter()
            .find(|m| m.email == email)
            .cloned())
    }

    fn members(&self) -> StoreResult<Vec<MemberRecord>> {
        Ok(self.lock()?.members.clone())
    }

    fn member_count(&self) -> StoreResult<usize> {
        Ok(self.lock()?.members.len())
    }

    fn delete_member(&self, id: MemberId) -> StoreResult<bool> {
        let mut m = self.lock()?;
        m.sessions.retain(|_, (member, _)| *member != id);
        let before = m.members.len();
        m.members.retain(|x| x.id != id);
        Ok(m.members.len() < before)
    }

    fn set_password(&self, id: MemberId, password_hash: &str) -> StoreResult<bool> {
        let mut m = self.lock()?;
        m.sessions.retain(|_, (member, _)| *member != id);
        match m.members.iter_mut().find(|x| x.id == id) {
            Some(x) => {
                x.password_hash = password_hash.to_string();
                Ok(true)
            }
            None => Ok(false),
        }
    }

    fn insert_session(
        &self,
        token_hash: &str,
        member: MemberId,
        expires_at: i64,
        now: i64,
    ) -> StoreResult<()> {
        let mut m = self.lock()?;
        m.sessions.retain(|_, (_, exp)| *exp > now);
        m.sessions
            .insert(token_hash.to_string(), (member, expires_at));
        Ok(())
    }

    fn session(&self, token_hash: &str, now: i64) -> StoreResult<Option<(MemberRecord, i64)>> {
        let m = self.lock()?;
        let Some(&(id, exp)) = m.sessions.get(token_hash) else {
            return Ok(None);
        };
        if exp <= now {
            return Ok(None);
        }
        Ok(m.members
            .iter()
            .find(|x| x.id == id)
            .map(|x| (x.clone(), exp)))
    }

    fn extend_session(&self, token_hash: &str, expires_at: i64) -> StoreResult<()> {
        if let Some(s) = self.lock()?.sessions.get_mut(token_hash) {
            s.1 = expires_at;
        }
        Ok(())
    }

    fn delete_session(&self, token_hash: &str) -> StoreResult<()> {
        self.lock()?.sessions.remove(token_hash);
        Ok(())
    }

    fn insert_invite(&self, invite: &InviteRecord) -> StoreResult<()> {
        self.lock()?.invites.push(invite.clone());
        Ok(())
    }

    fn invite_by_token_hash(&self, token_hash: &str) -> StoreResult<Option<InviteRecord>> {
        Ok(self
            .lock()?
            .invites
            .iter()
            .find(|i| i.token_hash == token_hash)
            .cloned())
    }

    fn pending_invites(&self, now: i64) -> StoreResult<Vec<InviteRecord>> {
        Ok(self
            .lock()?
            .invites
            .iter()
            .filter(|i| i.is_pending(now))
            .cloned()
            .collect())
    }

    fn delete_invite(&self, id: Uuid, now: i64) -> StoreResult<bool> {
        let mut m = self.lock()?;
        let before = m.invites.len();
        m.invites.retain(|i| !(i.id == id && i.is_pending(now)));
        Ok(m.invites.len() < before)
    }

    fn accept_invite(&self, invite: Uuid, member: &MemberRecord, now: i64) -> StoreResult<()> {
        let mut m = self.lock()?;
        let pos = m
            .invites
            .iter()
            .position(|i| i.id == invite && i.is_pending(now))
            .ok_or(StoreError::InviteGone)?;
        m.insert_member(member)?;
        if let Some(i) = m.invites.get_mut(pos) {
            i.used_at = Some(now);
        }
        Ok(())
    }
}
