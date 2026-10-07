//! Persistence: the `Store` trait, its SQLite implementation and an in-memory one for tests.
//!
//! Every method is blocking; async callers go through `tokio::task::spawn_blocking`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use qoop_core::{BranchId, MemberId, Workspace};
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

/// The Card a To-do points at: where and what it was when the pointer was set.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TodoCard {
    pub id: Uuid,
    pub title: String,
    pub branch: Uuid,
}

/// A stored To-do (contract §11); this is also its JSON shape.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TodoRecord {
    pub id: Uuid,
    /// Whose To-do it is.
    pub owner: MemberId,
    pub text: String,
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done_at: Option<i64>,
    /// Who added it: the owner, or someone assigning.
    pub created_by: MemberId,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card: Option<TodoCard>,
}

/// A stored access token (contract §12). Only the SHA-256 of its secret is kept.
#[derive(Debug, Clone, PartialEq)]
pub struct AccessTokenRecord {
    pub id: Uuid,
    pub member: MemberId,
    pub name: String,
    pub token_hash: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
}

/// What a Suggestion proposes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SuggestionKind {
    Source,
    Connection,
}

impl SuggestionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SuggestionKind::Source => "source",
            SuggestionKind::Connection => "connection",
        }
    }

    fn parse(s: &str) -> Option<SuggestionKind> {
        match s {
            "source" => Some(SuggestionKind::Source),
            "connection" => Some(SuggestionKind::Connection),
            _ => None,
        }
    }
}

/// Where a Suggestion stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SuggestionState {
    Pending,
    Accepted,
    Rejected,
}

impl SuggestionState {
    pub fn as_str(self) -> &'static str {
        match self {
            SuggestionState::Pending => "pending",
            SuggestionState::Accepted => "accepted",
            SuggestionState::Rejected => "rejected",
        }
    }

    fn parse(s: &str) -> Option<SuggestionState> {
        match s {
            "pending" => Some(SuggestionState::Pending),
            "accepted" => Some(SuggestionState::Accepted),
            "rejected" => Some(SuggestionState::Rejected),
            _ => None,
        }
    }
}

/// The Source a Suggestion proposes to attach.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SuggestedSource {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authors: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<String>,
}

/// The Connection a Suggestion proposes to draw.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SuggestedConnection {
    pub from: Uuid,
    pub to: Uuid,
    /// `related`, `directed` or `contradicts`.
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// A stored Suggestion (contract §12); this is also its JSON shape.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SuggestionRecord {
    pub id: Uuid,
    pub branch: BranchId,
    pub kind: SuggestionKind,
    /// Kind `source`: the Card to attach to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<SuggestedSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection: Option<SuggestedConnection>,
    pub reason: String,
    /// The Member whose access token proposed it.
    pub created_by: MemberId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub created_at: i64,
    pub state: SuggestionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decided_by: Option<MemberId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<i64>,
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

/// Accounts, sessions, invites, To-dos, access tokens, Suggestions and the Workspace
/// snapshot.
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
    /// Removes the account, all its sessions, its access tokens and the To-dos it owns
    /// (ones it created for others stay, as do its Suggestions); false if there was none.
    fn delete_member(&self, id: MemberId) -> StoreResult<bool>;
    /// Sets a new password hash and deletes all the account's sessions and access tokens;
    /// false if unknown.
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

    /// Ordered by creation time, then id.
    fn todos(&self) -> StoreResult<Vec<TodoRecord>>;
    fn todo(&self, id: Uuid) -> StoreResult<Option<TodoRecord>>;
    /// Stores a new To-do if its owner is an existing Member or Admin; false (and nothing
    /// stored) if the owner is unknown or a Guest.
    fn insert_todo(&self, todo: &TodoRecord) -> StoreResult<bool>;
    /// Replaces the To-do with the same id; false if there is none.
    fn update_todo(&self, todo: &TodoRecord) -> StoreResult<bool>;
    /// False if there was none.
    fn delete_todo(&self, id: Uuid) -> StoreResult<bool>;

    /// The Member's access tokens, oldest first.
    fn access_tokens(&self, member: MemberId) -> StoreResult<Vec<AccessTokenRecord>>;
    /// Stores a new access token unless its Member already has `max`; false (and nothing
    /// stored) then.
    fn insert_access_token(&self, token: &AccessTokenRecord, max: usize) -> StoreResult<bool>;
    /// Deletes one of the Member's own tokens; false if they have none with that id.
    fn delete_access_token(&self, member: MemberId, id: Uuid) -> StoreResult<bool>;
    /// The token with that secret hash and the Member it acts as.
    fn access_token_by_hash(
        &self,
        token_hash: &str,
    ) -> StoreResult<Option<(AccessTokenRecord, MemberRecord)>>;
    fn touch_access_token(&self, id: Uuid, now: i64) -> StoreResult<()>;

    /// The Suggestions of `branch` that are pending or were decided after `decided_after`;
    /// newest first.
    fn suggestions(
        &self,
        branch: BranchId,
        decided_after: i64,
    ) -> StoreResult<Vec<SuggestionRecord>>;
    fn suggestion(&self, id: Uuid) -> StoreResult<Option<SuggestionRecord>>;
    fn insert_suggestion(&self, suggestion: &SuggestionRecord) -> StoreResult<()>;
    /// Moves a Suggestion from state `from` to `to`, recording who decided and when (both
    /// `None` when it becomes pending again); false, and nothing changed, unless it is in
    /// state `from`.
    fn decide_suggestion(
        &self,
        id: Uuid,
        from: SuggestionState,
        to: SuggestionState,
        decided: Option<(MemberId, i64)>,
    ) -> StoreResult<bool>;
    /// Atomically replaces the Workspace snapshot and marks a pending Suggestion accepted;
    /// false, and nothing written, if the Suggestion is not pending.
    fn save_workspace_accepting(
        &self,
        ws: &Workspace,
        suggestion: Uuid,
        by: MemberId,
        at: i64,
    ) -> StoreResult<bool>;
}

// ---------------------------------------------------------------- SQLite

/// The schema version this binary writes; kept in `PRAGMA user_version`.
pub const SCHEMA_VERSION: i64 = 3;

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

/// M4: To-dos. They go with their owner's account.
const SCHEMA_V2: &str = "
CREATE TABLE todos (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    done INTEGER NOT NULL,
    done_at INTEGER,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    card_id TEXT,
    card_title TEXT,
    card_branch TEXT
);
CREATE INDEX todos_owner ON todos(owner);
";

/// M5: access tokens (they go with their Member's account) and Suggestions (which stay
/// when the Member who created them is removed).
const SCHEMA_V3: &str = "
CREATE TABLE access_tokens (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
);
CREATE INDEX access_tokens_member ON access_tokens(member_id);
CREATE TABLE suggestions (
    id TEXT PRIMARY KEY,
    branch TEXT NOT NULL,
    kind TEXT NOT NULL,
    card TEXT,
    source_url TEXT,
    source_doi TEXT,
    source_title TEXT,
    source_authors TEXT,
    source_year TEXT,
    conn_from TEXT,
    conn_to TEXT,
    conn_kind TEXT,
    conn_label TEXT,
    reason TEXT NOT NULL,
    created_by TEXT NOT NULL,
    model TEXT,
    created_at INTEGER NOT NULL,
    state TEXT NOT NULL,
    decided_by TEXT,
    decided_at INTEGER
);
CREATE INDEX suggestions_branch ON suggestions(branch, state);
";

/// Steps that bring a file from version `i` to `i + 1`; index 0 creates the schema.
/// A later version appends its step here.
const MIGRATIONS: &[&str] = &[SCHEMA_V1, SCHEMA_V2, SCHEMA_V3];

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

const TODO_COLS: &str =
    "id, owner, text, done, done_at, created_by, created_at, card_id, card_title, card_branch";

fn todo_row(r: &Row<'_>) -> rusqlite::Result<TodoRecord> {
    let card = match (
        r.get::<_, Option<String>>(7)?,
        r.get::<_, Option<String>>(8)?,
        r.get::<_, Option<String>>(9)?,
    ) {
        (Some(id), Some(title), Some(branch)) => Some(TodoCard {
            id: parse_uuid(&id)?,
            title,
            branch: parse_uuid(&branch)?,
        }),
        _ => None,
    };
    Ok(TodoRecord {
        id: parse_uuid(&r.get::<_, String>(0)?)?,
        owner: MemberId(parse_uuid(&r.get::<_, String>(1)?)?),
        text: r.get(2)?,
        done: r.get(3)?,
        done_at: r.get(4)?,
        created_by: MemberId(parse_uuid(&r.get::<_, String>(5)?)?),
        created_at: r.get(6)?,
        card,
    })
}

const TOKEN_COLS: &str = "id, member_id, name, token_hash, created_at, last_used_at";

fn token_row(r: &Row<'_>) -> rusqlite::Result<AccessTokenRecord> {
    Ok(AccessTokenRecord {
        id: parse_uuid(&r.get::<_, String>(0)?)?,
        member: MemberId(parse_uuid(&r.get::<_, String>(1)?)?),
        name: r.get(2)?,
        token_hash: r.get(3)?,
        created_at: r.get(4)?,
        last_used_at: r.get(5)?,
    })
}

const SUGGESTION_COLS: &str = "id, branch, kind, card, source_url, source_doi, source_title, \
     source_authors, source_year, conn_from, conn_to, conn_kind, conn_label, reason, \
     created_by, model, created_at, state, decided_by, decided_at";

fn bad_text(what: &str, s: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        format!("unknown {what} {s:?}").into(),
    )
}

fn opt_uuid(s: Option<String>) -> rusqlite::Result<Option<Uuid>> {
    s.as_deref().map(parse_uuid).transpose()
}

fn suggestion_row(r: &Row<'_>) -> rusqlite::Result<SuggestionRecord> {
    let kind: String = r.get(2)?;
    let kind = SuggestionKind::parse(&kind).ok_or_else(|| bad_text("suggestion kind", &kind))?;
    let state: String = r.get(17)?;
    let state =
        SuggestionState::parse(&state).ok_or_else(|| bad_text("suggestion state", &state))?;
    let source = (kind == SuggestionKind::Source).then_some(SuggestedSource {
        url: r.get(4)?,
        doi: r.get(5)?,
        title: r.get(6)?,
        authors: r.get(7)?,
        year: r.get(8)?,
    });
    let connection = match (
        opt_uuid(r.get(9)?)?,
        opt_uuid(r.get(10)?)?,
        r.get::<_, Option<String>>(11)?,
    ) {
        (Some(from), Some(to), Some(kind)) => Some(SuggestedConnection {
            from,
            to,
            kind,
            label: r.get(12)?,
        }),
        _ => None,
    };
    Ok(SuggestionRecord {
        id: parse_uuid(&r.get::<_, String>(0)?)?,
        branch: BranchId(parse_uuid(&r.get::<_, String>(1)?)?),
        kind,
        card: opt_uuid(r.get(3)?)?,
        source,
        connection,
        reason: r.get(13)?,
        created_by: MemberId(parse_uuid(&r.get::<_, String>(14)?)?),
        model: r.get(15)?,
        created_at: r.get(16)?,
        state,
        decided_by: opt_uuid(r.get(18)?)?.map(MemberId),
        decided_at: r.get(19)?,
    })
}

/// Marks a Suggestion decided (or pending again) if it is in state `from`.
fn decide_suggestion_on(
    conn: &Connection,
    id: Uuid,
    from: SuggestionState,
    to: SuggestionState,
    decided: Option<(MemberId, i64)>,
) -> StoreResult<bool> {
    let n = conn.execute(
        "UPDATE suggestions SET state = ?3, decided_by = ?4, decided_at = ?5
         WHERE id = ?1 AND state = ?2",
        params![
            id.to_string(),
            from.as_str(),
            to.as_str(),
            decided.map(|(by, _)| by.0.to_string()),
            decided.map(|(_, at)| at),
        ],
    )?;
    Ok(n > 0)
}

fn save_workspace_on(conn: &Connection, ws: &Workspace) -> StoreResult<()> {
    let json = serde_json::to_string(ws)?;
    conn.execute(
        "INSERT INTO workspace (id, json) VALUES (1, ?1)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json",
        params![json],
    )?;
    Ok(())
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
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        save_workspace_on(&tx, ws)?;
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
        tx.execute(
            "DELETE FROM access_tokens WHERE member_id = ?1",
            params![id],
        )?;
        tx.execute("DELETE FROM todos WHERE owner = ?1", params![id])?;
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
        tx.execute(
            "DELETE FROM access_tokens WHERE member_id = ?1",
            params![id],
        )?;
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

    fn todos(&self) -> StoreResult<Vec<TodoRecord>> {
        let conn = self.conn()?;
        let sql = format!("SELECT {TODO_COLS} FROM todos ORDER BY created_at, id");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], todo_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    fn todo(&self, id: Uuid) -> StoreResult<Option<TodoRecord>> {
        let sql = format!("SELECT {TODO_COLS} FROM todos WHERE id = ?1");
        Ok(self
            .conn()?
            .query_row(&sql, params![id.to_string()], todo_row)
            .optional()?)
    }

    fn insert_todo(&self, t: &TodoRecord) -> StoreResult<bool> {
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let owner = t.owner.0.to_string();
        let role: Option<String> = tx
            .query_row(
                "SELECT role FROM members WHERE id = ?1",
                params![owner],
                |r| r.get(0),
            )
            .optional()?;
        if !matches!(role.as_deref(), Some("admin" | "member")) {
            return Ok(false);
        }
        let sql = format!(
            "INSERT INTO todos ({TODO_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"
        );
        let card = t.card.as_ref();
        tx.execute(
            &sql,
            params![
                t.id.to_string(),
                owner,
                t.text,
                t.done,
                t.done_at,
                t.created_by.0.to_string(),
                t.created_at,
                card.map(|c| c.id.to_string()),
                card.map(|c| c.title.as_str()),
                card.map(|c| c.branch.to_string()),
            ],
        )?;
        tx.commit()?;
        Ok(true)
    }

    fn update_todo(&self, t: &TodoRecord) -> StoreResult<bool> {
        let card = t.card.as_ref();
        let n = self.conn()?.execute(
            "UPDATE todos SET text = ?2, done = ?3, done_at = ?4,
                 card_id = ?5, card_title = ?6, card_branch = ?7
             WHERE id = ?1",
            params![
                t.id.to_string(),
                t.text,
                t.done,
                t.done_at,
                card.map(|c| c.id.to_string()),
                card.map(|c| c.title.as_str()),
                card.map(|c| c.branch.to_string()),
            ],
        )?;
        Ok(n > 0)
    }

    fn delete_todo(&self, id: Uuid) -> StoreResult<bool> {
        let n = self
            .conn()?
            .execute("DELETE FROM todos WHERE id = ?1", params![id.to_string()])?;
        Ok(n > 0)
    }

    fn access_tokens(&self, member: MemberId) -> StoreResult<Vec<AccessTokenRecord>> {
        let conn = self.conn()?;
        let sql = format!(
            "SELECT {TOKEN_COLS} FROM access_tokens WHERE member_id = ?1 ORDER BY created_at, id"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![member.0.to_string()], token_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    fn insert_access_token(&self, t: &AccessTokenRecord, max: usize) -> StoreResult<bool> {
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let member = t.member.0.to_string();
        let have: i64 = tx.query_row(
            "SELECT COUNT(*) FROM access_tokens WHERE member_id = ?1",
            params![member],
            |r| r.get(0),
        )?;
        if usize::try_from(have).unwrap_or(usize::MAX) >= max {
            return Ok(false);
        }
        let sql =
            format!("INSERT INTO access_tokens ({TOKEN_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6)");
        tx.execute(
            &sql,
            params![
                t.id.to_string(),
                member,
                t.name,
                t.token_hash,
                t.created_at,
                t.last_used_at
            ],
        )?;
        tx.commit()?;
        Ok(true)
    }

    fn delete_access_token(&self, member: MemberId, id: Uuid) -> StoreResult<bool> {
        let n = self.conn()?.execute(
            "DELETE FROM access_tokens WHERE id = ?1 AND member_id = ?2",
            params![id.to_string(), member.0.to_string()],
        )?;
        Ok(n > 0)
    }

    fn access_token_by_hash(
        &self,
        token_hash: &str,
    ) -> StoreResult<Option<(AccessTokenRecord, MemberRecord)>> {
        let token_cols = TOKEN_COLS
            .split(", ")
            .map(|c| format!("t.{c}"))
            .collect::<Vec<_>>()
            .join(", ");
        let member_cols = MEMBER_COLS
            .split(", ")
            .map(|c| format!("m.{c}"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT {member_cols}, {token_cols} FROM access_tokens t
             JOIN members m ON m.id = t.member_id WHERE t.token_hash = ?1"
        );
        Ok(self
            .conn()?
            .query_row(&sql, params![token_hash], |r| {
                let member = member_row(r)?;
                let token = AccessTokenRecord {
                    id: parse_uuid(&r.get::<_, String>(8)?)?,
                    member: member.id,
                    name: r.get(10)?,
                    token_hash: r.get(11)?,
                    created_at: r.get(12)?,
                    last_used_at: r.get(13)?,
                };
                Ok((token, member))
            })
            .optional()?)
    }

    fn touch_access_token(&self, id: Uuid, now: i64) -> StoreResult<()> {
        self.conn()?.execute(
            "UPDATE access_tokens SET last_used_at = ?1 WHERE id = ?2",
            params![now, id.to_string()],
        )?;
        Ok(())
    }

    fn suggestions(
        &self,
        branch: BranchId,
        decided_after: i64,
    ) -> StoreResult<Vec<SuggestionRecord>> {
        let conn = self.conn()?;
        let sql = format!(
            "SELECT {SUGGESTION_COLS} FROM suggestions
             WHERE branch = ?1 AND (state = 'pending' OR decided_at > ?2)
             ORDER BY created_at DESC, id DESC"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![branch.0.to_string(), decided_after], suggestion_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    fn suggestion(&self, id: Uuid) -> StoreResult<Option<SuggestionRecord>> {
        let sql = format!("SELECT {SUGGESTION_COLS} FROM suggestions WHERE id = ?1");
        Ok(self
            .conn()?
            .query_row(&sql, params![id.to_string()], suggestion_row)
            .optional()?)
    }

    fn insert_suggestion(&self, s: &SuggestionRecord) -> StoreResult<()> {
        let sql = format!(
            "INSERT INTO suggestions ({SUGGESTION_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
             ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)"
        );
        let source = s.source.as_ref();
        let conn = s.connection.as_ref();
        self.conn()?.execute(
            &sql,
            params![
                s.id.to_string(),
                s.branch.0.to_string(),
                s.kind.as_str(),
                s.card.map(|c| c.to_string()),
                source.and_then(|x| x.url.as_deref()),
                source.and_then(|x| x.doi.as_deref()),
                source.and_then(|x| x.title.as_deref()),
                source.and_then(|x| x.authors.as_deref()),
                source.and_then(|x| x.year.as_deref()),
                conn.map(|c| c.from.to_string()),
                conn.map(|c| c.to.to_string()),
                conn.map(|c| c.kind.as_str()),
                conn.and_then(|c| c.label.as_deref()),
                s.reason,
                s.created_by.0.to_string(),
                s.model,
                s.created_at,
                s.state.as_str(),
                s.decided_by.map(|m| m.0.to_string()),
                s.decided_at,
            ],
        )?;
        Ok(())
    }

    fn decide_suggestion(
        &self,
        id: Uuid,
        from: SuggestionState,
        to: SuggestionState,
        decided: Option<(MemberId, i64)>,
    ) -> StoreResult<bool> {
        decide_suggestion_on(&*self.conn()?, id, from, to, decided)
    }

    fn save_workspace_accepting(
        &self,
        ws: &Workspace,
        suggestion: Uuid,
        by: MemberId,
        at: i64,
    ) -> StoreResult<bool> {
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let accepted = decide_suggestion_on(
            &tx,
            suggestion,
            SuggestionState::Pending,
            SuggestionState::Accepted,
            Some((by, at)),
        )?;
        if !accepted {
            return Ok(false);
        }
        save_workspace_on(&tx, ws)?;
        tx.commit()?;
        Ok(true)
    }
}

// ---------------------------------------------------------------- memory

#[derive(Default)]
struct Memory {
    workspace: Option<Workspace>,
    members: Vec<MemberRecord>,
    sessions: HashMap<String, (MemberId, i64)>,
    invites: Vec<InviteRecord>,
    todos: Vec<TodoRecord>,
    tokens: Vec<AccessTokenRecord>,
    suggestions: Vec<SuggestionRecord>,
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

    fn decide_suggestion(
        &mut self,
        id: Uuid,
        from: SuggestionState,
        to: SuggestionState,
        decided: Option<(MemberId, i64)>,
    ) -> bool {
        match self
            .suggestions
            .iter_mut()
            .find(|s| s.id == id && s.state == from)
        {
            Some(s) => {
                s.state = to;
                s.decided_by = decided.map(|(by, _)| by);
                s.decided_at = decided.map(|(_, at)| at);
                true
            }
            None => false,
        }
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
        m.tokens.retain(|t| t.member != id);
        m.todos.retain(|t| t.owner != id);
        let before = m.members.len();
        m.members.retain(|x| x.id != id);
        Ok(m.members.len() < before)
    }

    fn set_password(&self, id: MemberId, password_hash: &str) -> StoreResult<bool> {
        let mut m = self.lock()?;
        m.sessions.retain(|_, (member, _)| *member != id);
        if m.members.iter().any(|x| x.id == id) {
            m.tokens.retain(|t| t.member != id);
        }
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

    fn todos(&self) -> StoreResult<Vec<TodoRecord>> {
        let mut todos = self.lock()?.todos.clone();
        todos.sort_by_key(|t| (t.created_at, t.id.to_string()));
        Ok(todos)
    }

    fn todo(&self, id: Uuid) -> StoreResult<Option<TodoRecord>> {
        Ok(self.lock()?.todos.iter().find(|t| t.id == id).cloned())
    }

    fn insert_todo(&self, todo: &TodoRecord) -> StoreResult<bool> {
        let mut m = self.lock()?;
        let owner_ok = m
            .members
            .iter()
            .any(|x| x.id == todo.owner && x.role != Role::Guest);
        if owner_ok {
            m.todos.push(todo.clone());
        }
        Ok(owner_ok)
    }

    fn update_todo(&self, todo: &TodoRecord) -> StoreResult<bool> {
        match self.lock()?.todos.iter_mut().find(|t| t.id == todo.id) {
            Some(t) => {
                *t = todo.clone();
                Ok(true)
            }
            None => Ok(false),
        }
    }

    fn delete_todo(&self, id: Uuid) -> StoreResult<bool> {
        let mut m = self.lock()?;
        let before = m.todos.len();
        m.todos.retain(|t| t.id != id);
        Ok(m.todos.len() < before)
    }

    fn access_tokens(&self, member: MemberId) -> StoreResult<Vec<AccessTokenRecord>> {
        let mut tokens: Vec<AccessTokenRecord> = self
            .lock()?
            .tokens
            .iter()
            .filter(|t| t.member == member)
            .cloned()
            .collect();
        tokens.sort_by_key(|t| (t.created_at, t.id.to_string()));
        Ok(tokens)
    }

    fn insert_access_token(&self, token: &AccessTokenRecord, max: usize) -> StoreResult<bool> {
        let mut m = self.lock()?;
        if m.tokens.iter().filter(|t| t.member == token.member).count() >= max {
            return Ok(false);
        }
        m.tokens.push(token.clone());
        Ok(true)
    }

    fn delete_access_token(&self, member: MemberId, id: Uuid) -> StoreResult<bool> {
        let mut m = self.lock()?;
        let before = m.tokens.len();
        m.tokens.retain(|t| !(t.id == id && t.member == member));
        Ok(m.tokens.len() < before)
    }

    fn access_token_by_hash(
        &self,
        token_hash: &str,
    ) -> StoreResult<Option<(AccessTokenRecord, MemberRecord)>> {
        let m = self.lock()?;
        Ok(m.tokens
            .iter()
            .find(|t| t.token_hash == token_hash)
            .and_then(|t| {
                let member = m.members.iter().find(|x| x.id == t.member)?;
                Some((t.clone(), member.clone()))
            }))
    }

    fn touch_access_token(&self, id: Uuid, now: i64) -> StoreResult<()> {
        if let Some(t) = self.lock()?.tokens.iter_mut().find(|t| t.id == id) {
            t.last_used_at = Some(now);
        }
        Ok(())
    }

    fn suggestions(
        &self,
        branch: BranchId,
        decided_after: i64,
    ) -> StoreResult<Vec<SuggestionRecord>> {
        let mut list: Vec<SuggestionRecord> = self
            .lock()?
            .suggestions
            .iter()
            .filter(|s| {
                s.branch == branch
                    && (s.state == SuggestionState::Pending
                        || s.decided_at.is_some_and(|at| at > decided_after))
            })
            .cloned()
            .collect();
        list.sort_by_key(|s| std::cmp::Reverse((s.created_at, s.id.to_string())));
        Ok(list)
    }

    fn suggestion(&self, id: Uuid) -> StoreResult<Option<SuggestionRecord>> {
        Ok(self
            .lock()?
            .suggestions
            .iter()
            .find(|s| s.id == id)
            .cloned())
    }

    fn insert_suggestion(&self, suggestion: &SuggestionRecord) -> StoreResult<()> {
        self.lock()?.suggestions.push(suggestion.clone());
        Ok(())
    }

    fn decide_suggestion(
        &self,
        id: Uuid,
        from: SuggestionState,
        to: SuggestionState,
        decided: Option<(MemberId, i64)>,
    ) -> StoreResult<bool> {
        Ok(self.lock()?.decide_suggestion(id, from, to, decided))
    }

    fn save_workspace_accepting(
        &self,
        ws: &Workspace,
        suggestion: Uuid,
        by: MemberId,
        at: i64,
    ) -> StoreResult<bool> {
        let mut m = self.lock()?;
        let accepted = m.decide_suggestion(
            suggestion,
            SuggestionState::Pending,
            SuggestionState::Accepted,
            Some((by, at)),
        );
        if accepted {
            m.workspace = Some(ws.clone());
        }
        Ok(accepted)
    }
}
