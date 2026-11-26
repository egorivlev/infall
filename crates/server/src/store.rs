//! Persistence: the `Store` trait, its SQLite implementation and an in-memory one for tests.
//!
//! Every method is blocking; async callers go through `tokio::task::spawn_blocking`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use infall_core::{BranchId, MemberId, Workspace};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

mod content;
mod files;

pub use files::{CHUNK_BYTES, PdfFile, TextOutcome};

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
    /// Trimmed and lowercased. `None` for a Member who arrived as a name only, with a
    /// Workspace file (docs/specs/team-move.md, decisions 6 and 7): they cannot sign in until
    /// someone accepts an invite that claims them.
    pub email: Option<String>,
    pub name: String,
    pub role: Role,
    pub color: String,
    /// Argon2id PHC string.
    pub password_hash: String,
    /// Unix ms; guests only.
    pub access_until: Option<i64>,
    pub created_at: i64,
}

impl MemberRecord {
    /// Whether someone signs in as this Member: false for a name that came with a Workspace
    /// file and has not been claimed through an invite.
    pub fn claimed(&self) -> bool {
        self.email.is_some()
    }
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
    /// The unclaimed Member whom accepting this invite gives an email and a password,
    /// instead of making a new one (schema version 7).
    pub claims: Option<MemberId>,
}

/// A stored Comment (docs/specs/team-move.md, decision 9): outside versioning, one thread
/// per Card id, kept when the Card is removed.
#[derive(Debug, Clone, PartialEq)]
pub struct CommentRecord {
    pub id: Uuid,
    pub card: Uuid,
    pub author: MemberId,
    pub text: String,
    /// The Members it mentions, each once, in the order given.
    pub mentions: Vec<MemberId>,
    pub created_at: i64,
    pub edited_at: Option<i64>,
}

/// One entry of a Member's For you list: a Comment that mentions them.
#[derive(Debug, Clone, PartialEq)]
pub struct ForYouRecord {
    pub comment: Uuid,
    pub card: Uuid,
    pub author: MemberId,
    /// When they were mentioned: the Comment's creation, or the edit that added them.
    pub at: i64,
    pub seen: bool,
}

/// What `Store::import_prepared` did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportOutcome {
    Done,
    /// The Workspace is not empty (docs/specs/team-move.md, decision 1); nothing changed.
    NotEmpty,
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

/// A Member's OpenRouter key as it is kept: sealed, never in the clear (contract §14).
#[derive(Debug, Clone, PartialEq)]
pub struct AiKeyRecord {
    pub ciphertext: Vec<u8>,
    pub nonce: Vec<u8>,
    /// The last four characters of the key, so its owner can recognise it.
    pub last4: String,
    pub added_at: i64,
}

/// A Member's settings for the OpenRouter path of the AI sidebar.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AiSettingsRecord {
    pub key: Option<AiKeyRecord>,
    /// The model id the Member chose.
    pub model: Option<String>,
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

/// Accounts, sessions, invites, To-dos, access tokens, Suggestions, AI settings and the
/// Workspace (its Research Content).
pub trait Store: Send + Sync + 'static {
    fn load_workspace(&self) -> StoreResult<Option<Workspace>>;
    /// Makes `ws` the stored Workspace, atomically. The SQLite store writes only what
    /// differs from what it holds: for the usual `ws` — the stored one with Changes,
    /// Checkpoints or Branches added — that is the new rows alone.
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
    /// Atomically saves the Workspace (as `save_workspace`) and marks a pending Suggestion accepted;
    /// false, and nothing written, if the Suggestion is not pending.
    fn save_workspace_accepting(
        &self,
        ws: &Workspace,
        suggestion: Uuid,
        by: MemberId,
        at: i64,
    ) -> StoreResult<bool>;

    /// The Member's AI settings; the default (nothing set) if they have none.
    fn ai_settings(&self, member: MemberId) -> StoreResult<AiSettingsRecord>;
    /// Stores or replaces the Member's sealed key, or removes it (`None`); their model
    /// stays. False, and nothing stored, if there is no such Member.
    fn set_ai_key(&self, member: MemberId, key: Option<&AiKeyRecord>) -> StoreResult<bool>;
    /// Sets the Member's model; their key stays. False if there is no such Member.
    fn set_ai_model(&self, member: MemberId, model: &str) -> StoreResult<bool>;

    /// Gives a Member a new display name (already passed `clean_name`); false if unknown.
    fn set_member_name(&self, id: MemberId, name: &str) -> StoreResult<bool>;
    /// A value the server keeps about the Workspace itself (such as the Preset of a Local
    /// Workspace); `None` if it was never set.
    fn setting(&self, name: &str) -> StoreResult<Option<String>>;
    /// Stores or replaces such a value.
    fn set_setting(&self, name: &str, value: &str) -> StoreResult<()>;
    /// Forgets such a value; nothing happens if it was never set.
    fn remove_setting(&self, _name: &str) -> StoreResult<()> {
        Err(unsupported())
    }

    // ------------------------------------------------------------ Comments (schema 7)

    /// The thread of `card`: whether it is resolved, and its Comments, oldest first.
    fn comments(&self, _card: Uuid) -> StoreResult<(bool, Vec<CommentRecord>)> {
        Err(unsupported())
    }
    fn comment(&self, _id: Uuid) -> StoreResult<Option<CommentRecord>> {
        Err(unsupported())
    }
    /// Stores a new Comment, and an unseen For you entry (at its creation time) for each of
    /// `notify`; each of their lists is then cut to its newest `keep`.
    fn insert_comment(
        &self,
        _comment: &CommentRecord,
        _notify: &[MemberId],
        _keep: usize,
    ) -> StoreResult<()> {
        Err(unsupported())
    }
    /// Replaces a Comment's text, mentions and `edited_at`, and gives each of `notify` an
    /// unseen For you entry at `edited_at`; false, and nothing stored, if there is none.
    fn update_comment(
        &self,
        _comment: &CommentRecord,
        _notify: &[MemberId],
        _keep: usize,
    ) -> StoreResult<bool> {
        Err(unsupported())
    }
    /// Deletes a Comment and the For you entries that point at it; returns the Members who
    /// had one, or `None` if there was no such Comment.
    fn delete_comment(&self, _id: Uuid) -> StoreResult<Option<Vec<MemberId>>> {
        Err(unsupported())
    }
    fn set_thread_resolved(
        &self,
        _card: Uuid,
        _resolved: bool,
        _by: MemberId,
        _at: i64,
    ) -> StoreResult<()> {
        Err(unsupported())
    }
    /// Every Card with at least one Comment: how many, and whether its thread is resolved.
    fn comment_counts(&self) -> StoreResult<Vec<(Uuid, usize, bool)>> {
        Err(unsupported())
    }
    /// How many Comments there are in all.
    fn comment_total(&self) -> StoreResult<usize> {
        Err(unsupported())
    }
    /// The Member's For you list, newest first.
    fn for_you(&self, _member: MemberId) -> StoreResult<Vec<ForYouRecord>> {
        Err(unsupported())
    }
    /// Marks seen the Member's entry for `up_to` and every older one; false if they have no
    /// entry for that Comment.
    fn mark_for_you_seen(&self, _member: MemberId, _up_to: Uuid) -> StoreResult<bool> {
        Err(unsupported())
    }

    // ------------------------------------------------------------ Workspace files (M18)

    /// Brings in a Workspace file prepared for this Workspace (`local::port::prepare_for_team`)
    /// in one transaction, if the Workspace is empty (docs/specs/team-move.md, decision 1):
    /// its Research Content, To-dos, Suggestions, Comments and For you lists replace what is
    /// here, and its Members are added beside the ones that are here. On any failure nothing
    /// changes.
    fn import_prepared(&self, _file: &Path) -> StoreResult<ImportOutcome> {
        Err(unsupported())
    }

    // ------------------------------------------------------------ PDFs (schema 8)

    /// The stored file with that hash, if there is one.
    fn pdf_file(&self, _hash: &str) -> StoreResult<Option<PdfFile>> {
        Err(unsupported())
    }
    /// Stores the bytes of the file at `from`, whose SHA-256 is `hash` and which is `size`
    /// bytes long, all at once; false, and nothing written, when it is already stored.
    fn insert_pdf(&self, _hash: &str, _size: u64, _from: &Path, _at: i64) -> StoreResult<bool> {
        Err(unsupported())
    }
    /// Part `n` of a stored file: its bytes from `n * CHUNK_BYTES` up to the next part.
    fn pdf_chunk(&self, _hash: &str, _n: u64) -> StoreResult<Option<Vec<u8>>> {
        Err(unsupported())
    }
    /// Stores the text of each page of a stored file, unless it already has its text.
    fn set_pdf_text(&self, _hash: &str, _pages: &[String]) -> StoreResult<TextOutcome> {
        Err(unsupported())
    }
    /// The stored text of a file's pages, in order; `None` when there is none.
    fn pdf_text(&self, _hash: &str) -> StoreResult<Option<Vec<String>>> {
        Err(unsupported())
    }
    /// Calls `visit(hash, page, text)` for every stored page (pages counted from 0), by hash
    /// and then page, until it returns false.
    fn scan_pdf_text(&self, _visit: &mut dyn FnMut(&str, u32, &str) -> bool) -> StoreResult<()> {
        Err(unsupported())
    }
}

fn unsupported() -> StoreError {
    StoreError::Backend("this store does not support that".to_string())
}

// ---------------------------------------------------------------- SQLite

/// The schema version this binary writes; kept in `PRAGMA user_version`.
pub const SCHEMA_VERSION: i64 = 8;

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

/// M7: per Member, the sealed OpenRouter key and the chosen model. The row goes with the
/// account.
const SCHEMA_V4: &str = "
CREATE TABLE ai_settings (
    member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
    key_ciphertext BLOB,
    key_nonce BLOB,
    key_last4 TEXT,
    key_added_at INTEGER,
    model TEXT
);
";

/// M12: values about the Workspace itself, by name: the Preset a Local Workspace was created
/// from, and the progress of its Tutorial.
const SCHEMA_V5: &str = "
CREATE TABLE settings (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
";

/// M18 (docs/specs/team-move.md): Members who are names only (no email: `members` is made
/// again with `email` allowed to be null, the documented way, which `migrate` runs with
/// foreign keys off), invites that claim one, and Comments with their threads and the For
/// you lists, beside the content tables and outside versioning like To-dos.
const SCHEMA_V7: &str = "
CREATE TABLE members_v7 (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    color TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    access_until INTEGER,
    created_at INTEGER NOT NULL
);
INSERT INTO members_v7 (id, email, name, role, color, password_hash, access_until, created_at)
    SELECT id, email, name, role, color, password_hash, access_until, created_at FROM members;
DROP TABLE members;
ALTER TABLE members_v7 RENAME TO members;
ALTER TABLE invites ADD COLUMN claims TEXT;
CREATE TABLE comments (
    id TEXT PRIMARY KEY,
    card TEXT NOT NULL,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    mentions TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    edited_at INTEGER
);
CREATE INDEX comments_card ON comments(card, created_at);
CREATE TABLE comment_threads (
    card TEXT PRIMARY KEY,
    resolved INTEGER NOT NULL,
    resolved_by TEXT,
    resolved_at INTEGER
);
CREATE TABLE for_you (
    member TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    comment TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    card TEXT NOT NULL,
    author TEXT NOT NULL,
    at INTEGER NOT NULL,
    seen INTEGER NOT NULL,
    PRIMARY KEY (member, comment)
);
CREATE INDEX for_you_member ON for_you(member, at);
";

/// M19 (docs/specs/pdf-sources.md, Part 1): stored PDFs, by the SHA-256 of their bytes, and
/// the text of their pages. Outside the Change log and outside versioning: a Source names a
/// file by its hash, and one stored file serves every Source and Branch that names it. The
/// bytes are kept in parts of `files::CHUNK_BYTES`, so that a range is read without the
/// whole file. `text_pages` is null until the text is stored (`pdf_text`), once.
const SCHEMA_V8: &str = "
CREATE TABLE pdf_files (
    hash TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    text_pages INTEGER
);
CREATE TABLE pdf_chunks (
    hash TEXT NOT NULL REFERENCES pdf_files(hash),
    n INTEGER NOT NULL,
    bytes BLOB NOT NULL,
    PRIMARY KEY (hash, n)
);
CREATE TABLE pdf_text (
    hash TEXT NOT NULL REFERENCES pdf_files(hash),
    page INTEGER NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (hash, page)
);
";

/// The setting that changes whenever a Workspace file replaces the Research Content
/// (`import_prepared`). A server that read the Workspace before such a change refuses to
/// write it over the new one (see `SqliteStore::check_epoch`).
pub const CONTENT_EPOCH_SETTING: &str = "content_epoch";

/// One step of `MIGRATIONS`.
enum Step {
    Sql(&'static str),
    /// A step that moves data, not only the schema.
    Code(fn(&Connection) -> StoreResult<()>),
}

/// Steps that bring a file from version `i` to `i + 1`; index 0 creates the schema.
/// A later version appends its step here; a step is never changed once released, since
/// files at every earlier version are still opened (tests/migrations.rs).
const MIGRATIONS: &[Step] = &[
    Step::Sql(SCHEMA_V1),
    Step::Sql(SCHEMA_V2),
    Step::Sql(SCHEMA_V3),
    Step::Sql(SCHEMA_V4),
    Step::Sql(SCHEMA_V5),
    // Version 6: Research Content in tables (`store/content.rs`); the `workspace` row of
    // versions 1–5 is read into them and dropped.
    Step::Code(content::from_json_row),
    // Version 7: M18.
    Step::Sql(SCHEMA_V7),
    // Version 8: M19, PDFs on Sources.
    Step::Sql(SCHEMA_V8),
];

/// The SQLite store: one connection behind a mutex.
pub struct SqliteStore {
    conn: Mutex<Connection>,
    /// `CONTENT_EPOCH_SETTING` as it was when the Workspace was last read.
    epoch: Mutex<Option<String>>,
}

impl SqliteStore {
    /// Opens (creating if needed) and migrates the database file.
    ///
    /// On unix a file this call creates is private to its owner (mode 0600), and so are the
    /// `-wal` and `-shm` files SQLite keeps beside it, which take the mode of the database file.
    /// The rights of a file that is already there are never changed: one that others can read
    /// is left as it is — a second account may read it on purpose — and one line in the log
    /// says so.
    ///
    /// A file at an older schema version is brought up to this one (see `migrate`), with a
    /// copy of it as it was kept beside it until that has succeeded.
    pub fn open(path: &Path) -> StoreResult<SqliteStore> {
        #[cfg(unix)]
        private_file::prepare(path);
        let conn = Connection::open(path)?;
        Self::init(conn, on_disk(path))
    }

    /// A private in-memory SQLite database (tests).
    pub fn open_in_memory() -> StoreResult<SqliteStore> {
        Self::init(Connection::open_in_memory()?, None)
    }

    fn init(mut conn: Connection, file: Option<&Path>) -> StoreResult<SqliteStore> {
        // `journal_mode` returns a row, so it is read rather than executed.
        let _mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
        conn.execute_batch(
            "PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
        )?;
        migrate(&mut conn, file)?;
        Ok(SqliteStore {
            conn: Mutex::new(conn),
            epoch: Mutex::new(None),
        })
    }

    fn conn(&self) -> StoreResult<MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| StoreError::Backend("database lock poisoned".to_string()))
    }

    fn epoch(&self) -> StoreResult<MutexGuard<'_, Option<String>>> {
        self.epoch
            .lock()
            .map_err(|_| StoreError::Backend("epoch lock poisoned".to_string()))
    }

    /// Refuses to write the Workspace when the Research Content was replaced since it was
    /// read: by `infall-server import-workspace` run while this server was running. Writing
    /// then would put the old Workspace over the one brought in.
    fn check_epoch(&self, conn: &Connection) -> StoreResult<()> {
        let now = setting_on(conn, CONTENT_EPOCH_SETTING)?;
        if *self.epoch()? != now {
            return Err(StoreError::Backend(
                "the Workspace was replaced from the command line (import-workspace) while this server was running; restart the server to see it".to_string(),
            ));
        }
        Ok(())
    }
}

fn setting_on(conn: &Connection, name: &str) -> StoreResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT value FROM settings WHERE name = ?1",
            params![name],
            |r| r.get(0),
        )
        .optional()?)
}

/// Brings an open database file (a private scratch copy: no safety copy is made) up to
/// `SCHEMA_VERSION`; for Workspace files of older versions (`local::port`).
pub(crate) fn upgrade(conn: &mut Connection) -> StoreResult<()> {
    migrate(conn, None)
}

/// Keeping the database file to its owner (unix).
#[cfg(unix)]
mod private_file {
    use std::fs::OpenOptions;
    use std::io::ErrorKind;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    use std::path::Path;

    /// Creates the database file as an empty owner-only file if it is not there yet (SQLite
    /// takes an empty file for a new database), or looks at the rights of the one that is.
    /// Never fails: what cannot be done here is left to SQLite, which reports it.
    pub fn prepare(path: &Path) {
        // Not a file on disk: nothing, an in-memory database, or a `file:` URI.
        let name = path.to_string_lossy();
        if name.is_empty() || name == ":memory:" || name.starts_with("file:") {
            return;
        }
        // `create_new` so that a file made by someone else in the meantime is not taken for ours.
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
        {
            Ok(_) => {}
            Err(e) if e.kind() == ErrorKind::AlreadyExists => warn_if_open(path),
            Err(_) => {}
        }
    }

    fn warn_if_open(path: &Path) {
        let Ok(meta) = std::fs::metadata(path) else {
            return;
        };
        let mode = meta.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            tracing::warn!(
                "the database file {} can be opened by other accounts (mode {mode:o}); it was left as it is — `chmod 600` makes it private",
                path.display()
            );
        }
    }
}

/// `path` if it names a file on disk (not an in-memory database or a `file:` URI).
fn on_disk(path: &Path) -> Option<&Path> {
    let name = path.to_string_lossy();
    (!name.is_empty() && name != ":memory:" && !name.starts_with("file:")).then_some(path)
}

/// Where the copy of `db` at schema `version` is kept while it is migrated:
/// `<db>.v<version>-backup`, beside it.
pub fn migration_copy_path(db: &Path, version: i64) -> PathBuf {
    let mut name = db.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".v{version}-backup"));
    db.with_file_name(name)
}

/// Brings the file from its `user_version` to `SCHEMA_VERSION`: every step past it, all in
/// one transaction, so a failure anywhere leaves the file exactly as it was.
///
/// The safety copy (`file` on disk, and not a new database): before the first step the
/// file is copied, as it is, to `migration_copy_path` (`VACUUM INTO`: a consistent copy
/// that takes in what is still in the `-wal`, private to its owner, synced to disk). It is
/// removed only once the migration has verifiably succeeded: the steps themselves check
/// what they moved (version 6 reads the Workspace back from its tables and compares it
/// with the old row before it drops that), the transaction has committed, and
/// `PRAGMA quick_check` of the migrated file passes. Otherwise it stays, and the error
/// says where it is. A copy a run left behind because it stopped between the commit and
/// the removal is removed by the next open that finds the file at this version.
fn migrate(conn: &mut Connection, file: Option<&Path>) -> StoreResult<()> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if current > SCHEMA_VERSION {
        return Err(StoreError::Backend(format!(
            "database schema version {current} is newer than this binary ({SCHEMA_VERSION})"
        )));
    }
    if current == SCHEMA_VERSION {
        if let Some(db) = file {
            for version in 1..SCHEMA_VERSION {
                let left = migration_copy_path(db, version);
                if left.exists() {
                    let _ = std::fs::remove_file(&left);
                    tracing::info!("removed {}, left by a finished migration", left.display());
                }
            }
        }
        return Ok(());
    }
    let copy = match file {
        Some(db) if current > 0 => Some(safety_copy(conn, db, current)?),
        _ => None,
    };
    let kept = |e: StoreError| match &copy {
        Some(copy) => StoreError::Backend(format!(
            "{e} (migrating from schema version {current}; the file is unchanged, and a copy of it is at {})",
            copy.display()
        )),
        None => e,
    };
    // Foreign keys are off while the steps run (a pragma that does nothing inside a
    // transaction, so it is set around it), so that a step may make a table again — create
    // the new one, copy, drop the old, rename — without the drop deleting the rows that refer
    // to it; they are checked before the commit, and switched back on whatever happens.
    let fk_on: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0))?;
    conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
    let steps = (|| -> StoreResult<()> {
        let tx = conn.transaction()?;
        for step in MIGRATIONS.iter().skip(current.max(0) as usize) {
            match step {
                Step::Sql(sql) => tx.execute_batch(sql).map_err(|e| kept(e.into()))?,
                Step::Code(run) => run(&tx).map_err(kept)?,
            }
        }
        let broken: Option<String> = tx
            .query_row("PRAGMA foreign_key_check", [], |r| r.get(0))
            .optional()
            .map_err(|e| kept(e.into()))?;
        if let Some(table) = broken {
            return Err(kept(StoreError::Backend(format!(
                "rows of {table} refer to rows that are not there"
            ))));
        }
        // PRAGMA cannot take bound parameters; the value is our own integer.
        tx.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))
            .map_err(|e| kept(e.into()))?;
        tx.commit().map_err(|e| kept(e.into()))?;
        Ok(())
    })();
    if fk_on != 0 {
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    }
    steps?;
    if let Some(copy) = copy {
        // The pages the old layout used are given back (from before version 6: the whole
        // Workspace as one row). Only space: the file is complete without it.
        if let Err(e) = conn.execute_batch("VACUUM") {
            tracing::warn!("the migrated database could not be compacted: {e}");
        }
        let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        if check != "ok" {
            return Err(StoreError::Backend(format!(
                "the database failed its check after migrating from schema version {current} ({check}); a copy from before is at {}",
                copy.display()
            )));
        }
        // Not removable now: the next open at this version tries again.
        if let Err(e) = std::fs::remove_file(&copy) {
            tracing::warn!("the copy {} could not be removed: {e}", copy.display());
        }
        tracing::info!("migrated the database from schema version {current} to {SCHEMA_VERSION}");
    }
    Ok(())
}

/// Copies the database to `migration_copy_path` before a migration; see `migrate`.
fn safety_copy(conn: &Connection, db: &Path, version: i64) -> StoreResult<PathBuf> {
    let copy = migration_copy_path(db, version);
    let failed = |e: String| {
        StoreError::Backend(format!(
            "no copy of the database could be made at {} before migrating it, so it was left as it is: {e}",
            copy.display()
        ))
    };
    // One that is there already is from an attempt that did not finish: the file itself is
    // still at `version` (else no migration would run), so the copy is made again from it.
    if std::fs::symlink_metadata(&copy).is_ok() {
        std::fs::remove_file(&copy).map_err(|e| failed(e.to_string()))?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(&copy).map_err(|e| failed(e.to_string()))?;
    let into = copy
        .to_str()
        .ok_or_else(|| failed("the folder's name cannot be used".to_string()))?;
    conn.execute("VACUUM INTO ?1", params![into])
        .map_err(|e| failed(e.to_string()))?;
    std::fs::File::open(&copy)
        .and_then(|f| f.sync_all())
        .map_err(|e| failed(e.to_string()))?;
    Ok(copy)
}

/// The Workspace in an open database file at schema `version` (`PRAGMA user_version`),
/// read without migrating it: from the `workspace` row before version 6, from the tables
/// since. For checking a file (`local::port`).
pub(crate) fn workspace_in_file(conn: &Connection, version: i64) -> StoreResult<Option<Workspace>> {
    if version < 6 {
        let json: Option<String> = conn
            .query_row("SELECT json FROM workspace WHERE id = 1", [], |r| r.get(0))
            .optional()?;
        return Ok(match json {
            Some(j) => Some(serde_json::from_str(&j)?),
            None => None,
        });
    }
    content::load(conn)
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

const INVITE_COLS: &str = "id, token_hash, email, role, access_until, expires_at, created_by, \
     created_at, used_at, claims";

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
        claims: opt_uuid(r.get(9)?)?.map(MemberId),
    })
}

const COMMENT_COLS: &str = "id, card, author, text, mentions, created_at, edited_at";

fn comment_row(r: &Row<'_>) -> rusqlite::Result<CommentRecord> {
    let mentions: String = r.get(4)?;
    let mentions: Vec<MemberId> = serde_json::from_str(&mentions).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(CommentRecord {
        id: parse_uuid(&r.get::<_, String>(0)?)?,
        card: parse_uuid(&r.get::<_, String>(1)?)?,
        author: MemberId(parse_uuid(&r.get::<_, String>(2)?)?),
        text: r.get(3)?,
        mentions,
        created_at: r.get(5)?,
        edited_at: r.get(6)?,
    })
}

fn for_you_row(r: &Row<'_>) -> rusqlite::Result<ForYouRecord> {
    Ok(ForYouRecord {
        comment: parse_uuid(&r.get::<_, String>(0)?)?,
        card: parse_uuid(&r.get::<_, String>(1)?)?,
        author: MemberId(parse_uuid(&r.get::<_, String>(2)?)?),
        at: r.get(3)?,
        seen: r.get(4)?,
    })
}

/// Unseen For you entries for `notify` about `comment`, at `at`; each list then cut to `keep`.
fn notify_on(
    conn: &Connection,
    comment: &CommentRecord,
    notify: &[MemberId],
    at: i64,
    keep: usize,
) -> StoreResult<()> {
    for m in notify {
        let member = m.0.to_string();
        conn.execute(
            "INSERT INTO for_you (member, comment, card, author, at, seen)
             VALUES (?1, ?2, ?3, ?4, ?5, 0)
             ON CONFLICT(member, comment) DO UPDATE SET at = excluded.at, seen = 0",
            params![
                member,
                comment.id.to_string(),
                comment.card.to_string(),
                comment.author.0.to_string(),
                at
            ],
        )?;
        conn.execute(
            "DELETE FROM for_you WHERE member = ?1 AND rowid NOT IN (
                 SELECT rowid FROM for_you WHERE member = ?1
                 ORDER BY at DESC, comment DESC LIMIT ?2)",
            params![member, keep as i64],
        )?;
    }
    Ok(())
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
    content::save(conn, ws)
}

/// For tables that refer to Members by id, the ones a Member may be found in once a
/// Workspace file comes in (`local::port`): every column holding a Member id, and the text
/// columns where one is written inside (a Change's op, as `ai_pinned_by` or a Run result's
/// `by`; a Comment's mentions).
pub(crate) const MEMBER_ID_COLUMNS: &[(&str, &str)] = &[
    ("members", "id"),
    ("branches", "created_by"),
    ("changes", "author"),
    ("checkpoints", "author"),
    ("todos", "owner"),
    ("todos", "created_by"),
    ("suggestions", "created_by"),
    ("suggestions", "decided_by"),
    ("comments", "author"),
    ("comment_threads", "resolved_by"),
    ("for_you", "member"),
    ("for_you", "author"),
];
pub(crate) const MEMBER_ID_IN_TEXT: &[(&str, &str)] =
    &[("changes", "op"), ("comments", "mentions")];
/// Every column holding a Branch id.
pub(crate) const BRANCH_ID_COLUMNS: &[(&str, &str)] = &[
    ("branches", "id"),
    ("branches", "parent_branch"),
    ("changes", "branch"),
    ("changes", "source_branch"),
    ("checkpoints", "branch"),
    ("sync_points", "branch"),
    ("sync_points", "base_branch"),
    ("sync_points", "landed_branch"),
    ("todos", "card_branch"),
    ("suggestions", "branch"),
];

/// Replaces the id `from` by `to` in `columns` (and inside the text of `in_text`), in the
/// database `conn` has open as `main`. Ids are uuids, so a plain replacement of the text
/// finds exactly that id. Foreign keys must be off.
pub(crate) fn rename_id(
    conn: &Connection,
    columns: &[(&str, &str)],
    in_text: &[(&str, &str)],
    from: &str,
    to: &str,
) -> StoreResult<()> {
    for (table, col) in columns {
        conn.execute(
            &format!("UPDATE {table} SET {col} = ?2 WHERE {col} = ?1"),
            params![from, to],
        )?;
    }
    for (table, col) in in_text {
        conn.execute(
            &format!(
                "UPDATE {table} SET {col} = replace({col}, ?1, ?2) WHERE instr({col}, ?1) > 0"
            ),
            params![from, to],
        )?;
    }
    Ok(())
}

/// The columns `import_prepared` copies, table by table, in an order foreign keys accept.
const IMPORTED_TABLES: &[(&str, &str)] = &[
    (
        "branches",
        "id, name, parent_branch, parent_seq, created_by, created_at",
    ),
    (
        "changes",
        "branch, seq, id, author, at, op, origin, batch, to_seq, source_branch, source_seq",
    ),
    ("checkpoints", "branch, ord, name, seq, author, at"),
    (
        "sync_points",
        "branch, ord, base_branch, base_seq, landed_branch, landed_seq",
    ),
    ("todos", TODO_COLS),
    ("suggestions", SUGGESTION_COLS),
    ("comments", COMMENT_COLS),
    (
        "comment_threads",
        "card, resolved, resolved_by, resolved_at",
    ),
];

/// See `Store::import_prepared`. `file` is at this schema version, and its Members, ids and
/// Branch ids are already what they will be here.
fn import_prepared_on(conn: &mut Connection, file: &Path) -> StoreResult<ImportOutcome> {
    let path = file
        .to_str()
        .ok_or_else(|| StoreError::Backend("the file's path cannot be used".to_string()))?;
    conn.execute("ATTACH DATABASE ?1 AS incoming", params![path])?;
    let result = (|| -> StoreResult<ImportOutcome> {
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let count = |sql: &str| -> StoreResult<i64> { Ok(tx.query_row(sql, [], |r| r.get(0))?) };
        let branches: Vec<(String, String)> = {
            let mut stmt = tx.prepare("SELECT id, name FROM main.branches")?;
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        let incoming_main: Option<String> = tx
            .query_row(
                "SELECT id FROM incoming.branches WHERE parent_branch IS NULL AND name = 'main'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let empty = match branches.as_slice() {
            [] => true,
            [(id, name)] => name == "main" && incoming_main.as_deref() == Some(id.as_str()),
            _ => false,
        } && count("SELECT COUNT(*) FROM main.changes")? == 0
            && count("SELECT COUNT(*) FROM main.checkpoints")? == 0
            && count("SELECT COUNT(*) FROM main.todos")? == 0
            && count("SELECT COUNT(*) FROM main.comments")? == 0;
        if !empty {
            return Ok(ImportOutcome::NotEmpty);
        }
        for table in [
            "for_you",
            "comment_threads",
            "comments",
            "suggestions",
            "sync_points",
            "checkpoints",
            "changes",
            "branches",
        ] {
            tx.execute(&format!("DELETE FROM main.{table}"), [])?;
        }
        tx.execute(
            &format!(
                "INSERT INTO main.members ({MEMBER_COLS}) SELECT {MEMBER_COLS} FROM incoming.members
                 WHERE id NOT IN (SELECT id FROM main.members)"
            ),
            [],
        )?;
        for (table, cols) in IMPORTED_TABLES {
            tx.execute(
                &format!("INSERT INTO main.{table} ({cols}) SELECT {cols} FROM incoming.{table}"),
                [],
            )?;
        }
        // Stored PDFs are kept by their content and never replaced: the file's are added to
        // whatever is here (one may have been uploaded before the Workspace had content).
        tx.execute_batch(
            "INSERT OR IGNORE INTO main.pdf_files (hash, size, created_at, text_pages)
                 SELECT hash, size, created_at, NULL FROM incoming.pdf_files;
             INSERT OR IGNORE INTO main.pdf_chunks (hash, n, bytes)
                 SELECT hash, n, bytes FROM incoming.pdf_chunks;
             INSERT OR IGNORE INTO main.pdf_text (hash, page, text)
                 SELECT t.hash, t.page, t.text FROM incoming.pdf_text t
                 WHERE (SELECT m.text_pages FROM main.pdf_files m WHERE m.hash = t.hash) IS NULL;
             UPDATE main.pdf_files SET text_pages =
                 (SELECT i.text_pages FROM incoming.pdf_files i WHERE i.hash = main.pdf_files.hash)
                 WHERE text_pages IS NULL
                   AND hash IN (SELECT hash FROM incoming.pdf_files WHERE text_pages IS NOT NULL);",
        )?;
        tx.execute(
            "INSERT INTO main.for_you (member, comment, card, author, at, seen)
             SELECT member, comment, card, author, at, seen FROM incoming.for_you
             WHERE member IN (SELECT id FROM main.members)",
            [],
        )?;
        tx.execute(
            "INSERT INTO main.settings (name, value) VALUES (?1, ?2)
             ON CONFLICT(name) DO UPDATE SET value = excluded.value",
            params![CONTENT_EPOCH_SETTING, Uuid::new_v4().to_string()],
        )?;
        tx.commit()?;
        Ok(ImportOutcome::Done)
    })();
    let detached = conn.execute("DETACH DATABASE incoming", []);
    let outcome = result?;
    detached?;
    Ok(outcome)
}

fn member_exists_on(conn: &Connection, id: &str) -> StoreResult<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM members WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
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

/// Gives an unclaimed Member (no email) the email, name, role, password and access of
/// `m`: `InviteGone` if they are claimed or gone, `EmailTaken` if the email is in use.
fn claim_member_on(conn: &Connection, m: &MemberRecord) -> StoreResult<()> {
    let n = conn
        .execute(
            "UPDATE members SET email = ?2, name = ?3, role = ?4, password_hash = ?5,
                 access_until = ?6
             WHERE id = ?1 AND email IS NULL",
            params![
                m.id.0.to_string(),
                m.email,
                m.name,
                m.role.as_str(),
                m.password_hash,
                m.access_until
            ],
        )
        .map_err(|e| {
            if is_unique_violation(&e) {
                StoreError::EmailTaken
            } else {
                e.into()
            }
        })?;
    if n == 0 {
        return Err(StoreError::InviteGone);
    }
    Ok(())
}

impl Store for SqliteStore {
    fn remove_setting(&self, name: &str) -> StoreResult<()> {
        self.conn()?
            .execute("DELETE FROM settings WHERE name = ?1", params![name])?;
        Ok(())
    }

    fn comments(&self, card: Uuid) -> StoreResult<(bool, Vec<CommentRecord>)> {
        let conn = self.conn()?;
        let card = card.to_string();
        let resolved: Option<bool> = conn
            .query_row(
                "SELECT resolved FROM comment_threads WHERE card = ?1",
                params![card],
                |r| r.get(0),
            )
            .optional()?;
        let sql =
            format!("SELECT {COMMENT_COLS} FROM comments WHERE card = ?1 ORDER BY created_at, id");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![card], comment_row)?;
        Ok((
            resolved.unwrap_or(false),
            rows.collect::<rusqlite::Result<Vec<_>>>()?,
        ))
    }

    fn comment(&self, id: Uuid) -> StoreResult<Option<CommentRecord>> {
        let sql = format!("SELECT {COMMENT_COLS} FROM comments WHERE id = ?1");
        Ok(self
            .conn()?
            .query_row(&sql, params![id.to_string()], comment_row)
            .optional()?)
    }

    fn insert_comment(
        &self,
        c: &CommentRecord,
        notify: &[MemberId],
        keep: usize,
    ) -> StoreResult<()> {
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let sql =
            format!("INSERT INTO comments ({COMMENT_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)");
        tx.execute(
            &sql,
            params![
                c.id.to_string(),
                c.card.to_string(),
                c.author.0.to_string(),
                c.text,
                serde_json::to_string(&c.mentions)?,
                c.created_at,
                c.edited_at
            ],
        )?;
        notify_on(&tx, c, notify, c.created_at, keep)?;
        tx.commit()?;
        Ok(())
    }

    fn update_comment(
        &self,
        c: &CommentRecord,
        notify: &[MemberId],
        keep: usize,
    ) -> StoreResult<bool> {
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let n = tx.execute(
            "UPDATE comments SET text = ?2, mentions = ?3, edited_at = ?4 WHERE id = ?1",
            params![
                c.id.to_string(),
                c.text,
                serde_json::to_string(&c.mentions)?,
                c.edited_at
            ],
        )?;
        if n == 0 {
            return Ok(false);
        }
        notify_on(&tx, c, notify, c.edited_at.unwrap_or(c.created_at), keep)?;
        tx.commit()?;
        Ok(true)
    }

    fn delete_comment(&self, id: Uuid) -> StoreResult<Option<Vec<MemberId>>> {
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let id = id.to_string();
        let had: Vec<String> = {
            let mut stmt = tx.prepare("SELECT member FROM for_you WHERE comment = ?1")?;
            stmt.query_map(params![id], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        tx.execute("DELETE FROM for_you WHERE comment = ?1", params![id])?;
        let n = tx.execute("DELETE FROM comments WHERE id = ?1", params![id])?;
        if n == 0 {
            return Ok(None);
        }
        tx.commit()?;
        let had = had
            .iter()
            .map(|m| parse_uuid(m).map(MemberId))
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Some(had))
    }

    fn set_thread_resolved(
        &self,
        card: Uuid,
        resolved: bool,
        by: MemberId,
        at: i64,
    ) -> StoreResult<()> {
        self.conn()?.execute(
            "INSERT INTO comment_threads (card, resolved, resolved_by, resolved_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(card) DO UPDATE SET resolved = excluded.resolved,
                 resolved_by = excluded.resolved_by, resolved_at = excluded.resolved_at",
            params![card.to_string(), resolved, by.0.to_string(), at],
        )?;
        Ok(())
    }

    fn comment_counts(&self) -> StoreResult<Vec<(Uuid, usize, bool)>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT c.card, COUNT(*), COALESCE(t.resolved, 0) FROM comments c
             LEFT JOIN comment_threads t ON t.card = c.card
             GROUP BY c.card ORDER BY c.card",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                parse_uuid(&r.get::<_, String>(0)?)?,
                usize::try_from(r.get::<_, i64>(1)?).unwrap_or(0),
                r.get::<_, bool>(2)?,
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    fn comment_total(&self) -> StoreResult<usize> {
        let n: i64 = self
            .conn()?
            .query_row("SELECT COUNT(*) FROM comments", [], |r| r.get(0))?;
        Ok(usize::try_from(n).unwrap_or(0))
    }

    fn for_you(&self, member: MemberId) -> StoreResult<Vec<ForYouRecord>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT comment, card, author, at, seen FROM for_you WHERE member = ?1
             ORDER BY at DESC, comment DESC",
        )?;
        let rows = stmt.query_map(params![member.0.to_string()], for_you_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    fn mark_for_you_seen(&self, member: MemberId, up_to: Uuid) -> StoreResult<bool> {
        let conn = self.conn()?;
        let member = member.0.to_string();
        let up_to = up_to.to_string();
        let at: Option<i64> = conn
            .query_row(
                "SELECT at FROM for_you WHERE member = ?1 AND comment = ?2",
                params![member, up_to],
                |r| r.get(0),
            )
            .optional()?;
        let Some(at) = at else {
            return Ok(false);
        };
        conn.execute(
            "UPDATE for_you SET seen = 1
             WHERE member = ?1 AND (at < ?2 OR (at = ?2 AND comment <= ?3))",
            params![member, at, up_to],
        )?;
        Ok(true)
    }

    fn import_prepared(&self, file: &Path) -> StoreResult<ImportOutcome> {
        let mut conn = self.conn()?;
        import_prepared_on(&mut conn, file)
    }

    fn pdf_file(&self, hash: &str) -> StoreResult<Option<PdfFile>> {
        files::file_on(&*self.conn()?, hash)
    }

    fn insert_pdf(&self, hash: &str, size: u64, from: &Path, at: i64) -> StoreResult<bool> {
        files::insert_on(&mut *self.conn()?, hash, size, from, at)
    }

    fn pdf_chunk(&self, hash: &str, n: u64) -> StoreResult<Option<Vec<u8>>> {
        files::chunk_on(&*self.conn()?, hash, n)
    }

    fn set_pdf_text(&self, hash: &str, pages: &[String]) -> StoreResult<TextOutcome> {
        files::set_text_on(&mut *self.conn()?, hash, pages)
    }

    fn pdf_text(&self, hash: &str) -> StoreResult<Option<Vec<String>>> {
        files::text_on(&*self.conn()?, hash)
    }

    fn scan_pdf_text(&self, visit: &mut dyn FnMut(&str, u32, &str) -> bool) -> StoreResult<()> {
        files::scan_on(&*self.conn()?, visit)
    }

    fn load_workspace(&self) -> StoreResult<Option<Workspace>> {
        let conn = self.conn()?;
        // One read transaction, so the tables are read as of one moment.
        conn.execute_batch("BEGIN")?;
        let ws = content::load(&conn);
        let epoch = setting_on(&conn, CONTENT_EPOCH_SETTING);
        conn.execute_batch("COMMIT")?;
        *self.epoch()? = epoch?;
        ws
    }

    fn save_workspace(&self, ws: &Workspace) -> StoreResult<()> {
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        self.check_epoch(&tx)?;
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
        tx.execute("DELETE FROM ai_settings WHERE member_id = ?1", params![id])?;
        tx.execute("DELETE FROM for_you WHERE member = ?1", params![id])?;
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
            "INSERT INTO invites ({INVITE_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"
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
                i.used_at,
                i.claims.map(|m| m.0.to_string()),
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
        let claims: Option<String> = tx.query_row(
            "SELECT claims FROM invites WHERE id = ?1",
            params![invite.to_string()],
            |r| r.get(0),
        )?;
        if claims.is_some_and(|c| c == member.id.0.to_string()) {
            claim_member_on(&tx, member)?;
        } else {
            insert_member_on(&tx, member)?;
        }
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
        self.check_epoch(&tx)?;
        save_workspace_on(&tx, ws)?;
        tx.commit()?;
        Ok(true)
    }

    fn ai_settings(&self, member: MemberId) -> StoreResult<AiSettingsRecord> {
        type Columns = (
            Option<Vec<u8>>,
            Option<Vec<u8>>,
            Option<String>,
            Option<i64>,
            Option<String>,
        );
        let row: Option<Columns> = self
            .conn()?
            .query_row(
                "SELECT key_ciphertext, key_nonce, key_last4, key_added_at, model
                 FROM ai_settings WHERE member_id = ?1",
                params![member.0.to_string()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        Ok(match row {
            None => AiSettingsRecord::default(),
            Some((ciphertext, nonce, last4, added_at, model)) => AiSettingsRecord {
                key: match (ciphertext, nonce, last4, added_at) {
                    (Some(ciphertext), Some(nonce), Some(last4), Some(added_at)) => {
                        Some(AiKeyRecord {
                            ciphertext,
                            nonce,
                            last4,
                            added_at,
                        })
                    }
                    _ => None,
                },
                model,
            },
        })
    }

    fn set_ai_key(&self, member: MemberId, key: Option<&AiKeyRecord>) -> StoreResult<bool> {
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let id = member.0.to_string();
        if !member_exists_on(&tx, &id)? {
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO ai_settings (member_id, key_ciphertext, key_nonce, key_last4, key_added_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(member_id) DO UPDATE SET
                 key_ciphertext = excluded.key_ciphertext,
                 key_nonce = excluded.key_nonce,
                 key_last4 = excluded.key_last4,
                 key_added_at = excluded.key_added_at",
            params![
                id,
                key.map(|k| &k.ciphertext),
                key.map(|k| &k.nonce),
                key.map(|k| &k.last4),
                key.map(|k| k.added_at)
            ],
        )?;
        tx.commit()?;
        Ok(true)
    }

    fn set_ai_model(&self, member: MemberId, model: &str) -> StoreResult<bool> {
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let id = member.0.to_string();
        if !member_exists_on(&tx, &id)? {
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO ai_settings (member_id, model) VALUES (?1, ?2)
             ON CONFLICT(member_id) DO UPDATE SET model = excluded.model",
            params![id, model],
        )?;
        tx.commit()?;
        Ok(true)
    }

    fn set_member_name(&self, id: MemberId, name: &str) -> StoreResult<bool> {
        let n = self.conn()?.execute(
            "UPDATE members SET name = ?1 WHERE id = ?2",
            params![name, id.0.to_string()],
        )?;
        Ok(n > 0)
    }

    fn setting(&self, name: &str) -> StoreResult<Option<String>> {
        Ok(self
            .conn()?
            .query_row(
                "SELECT value FROM settings WHERE name = ?1",
                params![name],
                |r| r.get(0),
            )
            .optional()?)
    }

    fn set_setting(&self, name: &str, value: &str) -> StoreResult<()> {
        self.conn()?.execute(
            "INSERT INTO settings (name, value) VALUES (?1, ?2)
             ON CONFLICT(name) DO UPDATE SET value = excluded.value",
            params![name, value],
        )?;
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
    todos: Vec<TodoRecord>,
    tokens: Vec<AccessTokenRecord>,
    suggestions: Vec<SuggestionRecord>,
    ai: HashMap<MemberId, AiSettingsRecord>,
    settings: HashMap<String, String>,
    comments: Vec<CommentRecord>,
    resolved: HashMap<Uuid, bool>,
    for_you: HashMap<MemberId, Vec<ForYouRecord>>,
    /// Stored PDFs by hash: the bytes, and the text of the pages once stored.
    pdfs: std::collections::BTreeMap<String, (Vec<u8>, Option<Vec<String>>)>,
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
        if m.email.is_some() && self.members.iter().any(|x| x.email == m.email) {
            return Err(StoreError::EmailTaken);
        }
        self.members.push(m.clone());
        Ok(())
    }

    fn notify(&mut self, c: &CommentRecord, notify: &[MemberId], at: i64, keep: usize) {
        for m in notify {
            let list = self.for_you.entry(*m).or_default();
            list.retain(|e| e.comment != c.id);
            list.push(ForYouRecord {
                comment: c.id,
                card: c.card,
                author: c.author,
                at,
                seen: false,
            });
            list.sort_by_key(|e| std::cmp::Reverse((e.at, e.comment.to_string())));
            list.truncate(keep);
        }
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
            .find(|m| m.email.as_deref() == Some(email))
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
        m.ai.remove(&id);
        m.for_you.remove(&id);
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
        if m.invites[pos].claims == Some(member.id) {
            if m.members
                .iter()
                .any(|x| x.id != member.id && x.email == member.email)
            {
                return Err(StoreError::EmailTaken);
            }
            let slot = m
                .members
                .iter_mut()
                .find(|x| x.id == member.id && x.email.is_none())
                .ok_or(StoreError::InviteGone)?;
            *slot = MemberRecord {
                color: slot.color.clone(),
                created_at: slot.created_at,
                ..member.clone()
            };
        } else {
            m.insert_member(member)?;
        }
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

    fn ai_settings(&self, member: MemberId) -> StoreResult<AiSettingsRecord> {
        Ok(self.lock()?.ai.get(&member).cloned().unwrap_or_default())
    }

    fn set_ai_key(&self, member: MemberId, key: Option<&AiKeyRecord>) -> StoreResult<bool> {
        let mut m = self.lock()?;
        if !m.members.iter().any(|x| x.id == member) {
            return Ok(false);
        }
        m.ai.entry(member).or_default().key = key.cloned();
        Ok(true)
    }

    fn set_ai_model(&self, member: MemberId, model: &str) -> StoreResult<bool> {
        let mut m = self.lock()?;
        if !m.members.iter().any(|x| x.id == member) {
            return Ok(false);
        }
        m.ai.entry(member).or_default().model = Some(model.to_string());
        Ok(true)
    }

    fn set_member_name(&self, id: MemberId, name: &str) -> StoreResult<bool> {
        match self.lock()?.members.iter_mut().find(|x| x.id == id) {
            Some(x) => {
                x.name = name.to_string();
                Ok(true)
            }
            None => Ok(false),
        }
    }

    fn setting(&self, name: &str) -> StoreResult<Option<String>> {
        Ok(self.lock()?.settings.get(name).cloned())
    }

    fn set_setting(&self, name: &str, value: &str) -> StoreResult<()> {
        self.lock()?
            .settings
            .insert(name.to_string(), value.to_string());
        Ok(())
    }

    fn remove_setting(&self, name: &str) -> StoreResult<()> {
        self.lock()?.settings.remove(name);
        Ok(())
    }

    fn comments(&self, card: Uuid) -> StoreResult<(bool, Vec<CommentRecord>)> {
        let m = self.lock()?;
        let mut list: Vec<CommentRecord> = m
            .comments
            .iter()
            .filter(|c| c.card == card)
            .cloned()
            .collect();
        list.sort_by_key(|c| (c.created_at, c.id.to_string()));
        Ok((m.resolved.get(&card).copied().unwrap_or(false), list))
    }

    fn comment(&self, id: Uuid) -> StoreResult<Option<CommentRecord>> {
        Ok(self.lock()?.comments.iter().find(|c| c.id == id).cloned())
    }

    fn insert_comment(
        &self,
        comment: &CommentRecord,
        notify: &[MemberId],
        keep: usize,
    ) -> StoreResult<()> {
        let mut m = self.lock()?;
        m.comments.push(comment.clone());
        m.notify(comment, notify, comment.created_at, keep);
        Ok(())
    }

    fn update_comment(
        &self,
        comment: &CommentRecord,
        notify: &[MemberId],
        keep: usize,
    ) -> StoreResult<bool> {
        let mut m = self.lock()?;
        let Some(c) = m.comments.iter_mut().find(|c| c.id == comment.id) else {
            return Ok(false);
        };
        c.text = comment.text.clone();
        c.mentions = comment.mentions.clone();
        c.edited_at = comment.edited_at;
        let at = comment.edited_at.unwrap_or(comment.created_at);
        m.notify(comment, notify, at, keep);
        Ok(true)
    }

    fn delete_comment(&self, id: Uuid) -> StoreResult<Option<Vec<MemberId>>> {
        let mut m = self.lock()?;
        let before = m.comments.len();
        m.comments.retain(|c| c.id != id);
        if m.comments.len() == before {
            return Ok(None);
        }
        let mut had = Vec::new();
        for (member, list) in m.for_you.iter_mut() {
            let n = list.len();
            list.retain(|e| e.comment != id);
            if list.len() < n {
                had.push(*member);
            }
        }
        Ok(Some(had))
    }

    fn set_thread_resolved(
        &self,
        card: Uuid,
        resolved: bool,
        _by: MemberId,
        _at: i64,
    ) -> StoreResult<()> {
        self.lock()?.resolved.insert(card, resolved);
        Ok(())
    }

    fn comment_counts(&self) -> StoreResult<Vec<(Uuid, usize, bool)>> {
        let m = self.lock()?;
        let mut counts: std::collections::BTreeMap<Uuid, usize> = Default::default();
        for c in &m.comments {
            *counts.entry(c.card).or_default() += 1;
        }
        Ok(counts
            .into_iter()
            .map(|(card, n)| (card, n, m.resolved.get(&card).copied().unwrap_or(false)))
            .collect())
    }

    fn comment_total(&self) -> StoreResult<usize> {
        Ok(self.lock()?.comments.len())
    }

    fn for_you(&self, member: MemberId) -> StoreResult<Vec<ForYouRecord>> {
        Ok(self
            .lock()?
            .for_you
            .get(&member)
            .cloned()
            .unwrap_or_default())
    }

    fn mark_for_you_seen(&self, member: MemberId, up_to: Uuid) -> StoreResult<bool> {
        let mut m = self.lock()?;
        let Some(list) = m.for_you.get_mut(&member) else {
            return Ok(false);
        };
        let Some(pos) = list.iter().position(|e| e.comment == up_to) else {
            return Ok(false);
        };
        // Newest first: the entry and everything after it are as old or older.
        for e in &mut list[pos..] {
            e.seen = true;
        }
        Ok(true)
    }

    fn pdf_file(&self, hash: &str) -> StoreResult<Option<PdfFile>> {
        Ok(self.lock()?.pdfs.get(hash).map(|(bytes, text)| PdfFile {
            hash: hash.to_string(),
            size: bytes.len() as u64,
            has_text: text.is_some(),
        }))
    }

    fn insert_pdf(&self, hash: &str, size: u64, from: &Path, _at: i64) -> StoreResult<bool> {
        let mut m = self.lock()?;
        if m.pdfs.contains_key(hash) {
            return Ok(false);
        }
        let bytes = std::fs::read(from)
            .map_err(|e| StoreError::Backend(format!("the uploaded file: {e}")))?;
        if bytes.len() as u64 != size {
            return Err(StoreError::Backend(
                "the uploaded file changed while it was stored".to_string(),
            ));
        }
        m.pdfs.insert(hash.to_string(), (bytes, None));
        Ok(true)
    }

    fn pdf_chunk(&self, hash: &str, n: u64) -> StoreResult<Option<Vec<u8>>> {
        let m = self.lock()?;
        let Some((bytes, _)) = m.pdfs.get(hash) else {
            return Ok(None);
        };
        let start = n.saturating_mul(CHUNK_BYTES);
        if start >= bytes.len() as u64 {
            return Ok(None);
        }
        let end = (start + CHUNK_BYTES).min(bytes.len() as u64);
        Ok(Some(bytes[start as usize..end as usize].to_vec()))
    }

    fn set_pdf_text(&self, hash: &str, pages: &[String]) -> StoreResult<TextOutcome> {
        let mut m = self.lock()?;
        Ok(match m.pdfs.get_mut(hash) {
            None => TextOutcome::NoFile,
            Some((_, Some(_))) => TextOutcome::AlreadyStored,
            Some((_, text)) => {
                *text = Some(pages.to_vec());
                TextOutcome::Stored
            }
        })
    }

    fn pdf_text(&self, hash: &str) -> StoreResult<Option<Vec<String>>> {
        Ok(self.lock()?.pdfs.get(hash).and_then(|(_, t)| t.clone()))
    }

    fn scan_pdf_text(&self, visit: &mut dyn FnMut(&str, u32, &str) -> bool) -> StoreResult<()> {
        let m = self.lock()?;
        for (hash, (_, text)) in &m.pdfs {
            for (i, page) in text.iter().flatten().enumerate() {
                if !visit(hash, i as u32, page) {
                    return Ok(());
                }
            }
        }
        Ok(())
    }
}
