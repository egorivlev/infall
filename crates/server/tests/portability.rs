//! M13 — Workspace files (docs/specs/portability.md, Contract A; api.md §17): a Local
//! Workspace exported to one file without its secrets, and a new Local Workspace imported
//! from one.

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use common::{create_card, new_id, web_dir};
use qoop_server::auth::token_hash;
use qoop_server::local::{
    APPLICATION_ID, LocalOptions, LocalServer, PortError, Preset, export_workspace,
    import_workspace, secret_key_path, start_local,
};
use qoop_server::store::{SCHEMA_VERSION, SqliteStore, Store};
use qoop_server::{Clock, create_admin};
use serde_json::{Value, json};

const KEY: &str = "sk-or-v1-0f1e2d3c4b5a69788796a5b4c3d2e1f0-PORTABLE-TAIL";

/// A signed-in client of a running Local Workspace.
struct Client {
    http: reqwest::Client,
    origin: String,
    cookie: String,
    /// The session token itself, as the cookie carries it.
    session: String,
}

impl Client {
    async fn enter(server: &LocalServer) -> Client {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let res = http.get(server.entry_url()).send().await.unwrap();
        assert_eq!(res.status(), reqwest::StatusCode::SEE_OTHER);
        let cookie = res.headers()[reqwest::header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string();
        let (name, session) = cookie.split_once('=').unwrap();
        assert!(name.starts_with("qoop_session_"), "{name}");
        let session = session.to_string();
        Client {
            http,
            origin: server.origin().to_string(),
            cookie,
            session,
        }
    }

    async fn get(&self, path: &str) -> Value {
        let res = self
            .http
            .get(format!("{}{path}", self.origin))
            .header(reqwest::header::COOKIE, &self.cookie)
            .send()
            .await
            .unwrap();
        assert!(res.status().is_success(), "GET {path}: {}", res.status());
        res.json().await.unwrap()
    }

    async fn send(&self, method: reqwest::Method, path: &str, body: Value) -> (u16, Value) {
        let res = self
            .http
            .request(method, format!("{}{path}", self.origin))
            .header(reqwest::header::COOKIE, &self.cookie)
            .header(reqwest::header::ORIGIN, &self.origin)
            .header("x-qoop-request", "1")
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = res.status().as_u16();
        let text = res.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    async fn ok(&self, method: reqwest::Method, path: &str, body: Value) -> Value {
        let (status, body) = self.send(method, path, body).await;
        assert!((200..300).contains(&status), "{path}: {status} {body}");
        body
    }

    async fn main_branch(&self) -> String {
        let branches = self.get("/api/branches").await;
        branches["branches"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["name"] == "main")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string()
    }
}

async fn start(db: &Path, web: &Path, preset: Preset, name: &str) -> LocalServer {
    start_local(LocalOptions {
        db: db.to_path_buf(),
        web_dir: web.to_path_buf(),
        preset,
        member_name: name.to_string(),
        port: None,
        read_only: false,
    })
    .await
    .unwrap()
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|w| w == needle)
}

fn count(db: &Path, table: &str) -> i64 {
    let conn = rusqlite::Connection::open(db).unwrap();
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

/// Everything of a Workspace that an export must carry, in a form that compares.
fn contents(db: &Path) -> Value {
    let store = SqliteStore::open(db).unwrap();
    let ws = store.load_workspace().unwrap().unwrap();
    let mut suggestions = Vec::new();
    for b in ws.branches() {
        for s in store.suggestions(b.id(), 0).unwrap() {
            suggestions.push(serde_json::to_value(&s).unwrap());
        }
    }
    let members: Vec<Value> = store
        .members()
        .unwrap()
        .into_iter()
        .map(|m| {
            json!({
                "id": m.id.0, "name": m.name, "email": m.email, "role": m.role.as_str(),
                "color": m.color, "created_at": m.created_at, "access_until": m.access_until,
            })
        })
        .collect();
    json!({
        "workspace": serde_json::to_value(&ws).unwrap(),
        "todos": serde_json::to_value(store.todos().unwrap()).unwrap(),
        "suggestions": suggestions,
        "members": members,
        "preset": store.setting("preset").unwrap(),
        "tutorial": store.setting("tutorial_state").unwrap(),
    })
}

/// Every secret a running Workspace holds once its Member has used it the way a person does.
struct Secrets {
    session: String,
    access_token: String,
    ciphertext: Vec<u8>,
    password_hash: String,
    secret_key: String,
    entry_key: String,
}

/// A Workspace of `preset` that has been used: an OpenRouter key and a model, an access
/// token, the Tutorial's progress, a To-do and a Card of its own. Returns the running server,
/// its client and its secrets.
async fn used(db: &Path, web: &Path, preset: Preset) -> (LocalServer, Client, Secrets) {
    let server = start(db, web, preset, "Ada Lovelace").await;
    let c = Client::enter(&server).await;
    use reqwest::Method;
    c.ok(Method::PUT, "/api/ai/key", json!({ "key": KEY }))
        .await;
    c.ok(
        Method::PUT,
        "/api/ai/model",
        json!({ "model": "fake/model-1" }),
    )
    .await;
    let token = c
        .ok(Method::POST, "/api/tokens", json!({ "name": "Laptop" }))
        .await;
    c.ok(
        Method::PUT,
        "/api/local/tutorial",
        json!({ "state": { "step": 4 } }),
    )
    .await;
    let me = c.get("/api/me").await["member"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    c.ok(
        Method::POST,
        "/api/todos",
        json!({ "owner": me, "text": "Read the exported file" }),
    )
    .await;
    let main = c.main_branch().await;
    c.ok(
        Method::POST,
        &format!("/api/branches/{main}/ops"),
        json!({ "ops": [create_card(&new_id(), "Made before the export")] }),
    )
    .await;

    // Read the secrets straight from the database, the way the export would see them.
    let store = SqliteStore::open(db).unwrap();
    let member = store.members().unwrap().remove(0);
    let ciphertext = store
        .ai_settings(member.id)
        .unwrap()
        .key
        .expect("a sealed key")
        .ciphertext;
    let entry_key = server.entry_url().split("key=").nth(1).unwrap().to_string();
    let secrets = Secrets {
        session: c.session.clone(),
        access_token: token["secret"].as_str().unwrap().to_string(),
        ciphertext,
        password_hash: member.password_hash,
        secret_key: std::fs::read_to_string(secret_key_path(db)).unwrap(),
        entry_key,
    };
    (server, c, secrets)
}

/// The Research Content tables of a Workspace file (schema version 6 on).
const CONTENT_TABLES: [&str; 4] = ["branches", "changes", "checkpoints", "sync_points"];

/// Every value of every table of the database at `db`, table by table: the same secrets
/// searched for in what SQLite reads, not only in the bytes of the file (a value could be
/// stored compressed or split over pages in a layout to come). The Research Content
/// tables must be there and hold the Workspace.
fn assert_no_secrets_in_any_table(db: &Path, s: &Secrets) {
    let conn = rusqlite::Connection::open(db).unwrap();
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    for table in CONTENT_TABLES {
        assert!(
            tables.iter().any(|t| t == table),
            "no {table} in {tables:?}"
        );
    }
    assert!(count(db, "branches") > 0 && count(db, "changes") > 0);
    for table in &tables {
        let mut stmt = conn.prepare(&format!("SELECT * FROM {table}")).unwrap();
        let n = stmt.column_count();
        let mut cells: Vec<u8> = Vec::new();
        let mut rows = stmt.query([]).unwrap();
        while let Some(r) = rows.next().unwrap() {
            for i in 0..n {
                match r.get_ref(i).unwrap() {
                    rusqlite::types::ValueRef::Text(t) | rusqlite::types::ValueRef::Blob(t) => {
                        cells.extend_from_slice(t);
                        cells.push(0);
                    }
                    _ => {}
                }
            }
        }
        assert_no_secrets(&cells, s);
    }
}

fn assert_no_secrets(bytes: &[u8], s: &Secrets) {
    let checks: Vec<(&str, Vec<u8>)> = vec![
        ("the OpenRouter key", KEY.as_bytes().to_vec()),
        ("the key's tail", b"PORTABLE-TAIL".to_vec()),
        ("the sealed key", s.ciphertext.clone()),
        ("the session token", s.session.as_bytes().to_vec()),
        ("the session hash", token_hash(&s.session).into_bytes()),
        ("the access token", s.access_token.as_bytes().to_vec()),
        (
            "the access token hash",
            token_hash(&s.access_token).into_bytes(),
        ),
        ("the password hash", s.password_hash.as_bytes().to_vec()),
        ("the secret key", s.secret_key.trim().as_bytes().to_vec()),
        ("the entry key", s.entry_key.as_bytes().to_vec()),
        ("the model", b"fake/model-1".to_vec()),
    ];
    for (what, needle) in checks {
        assert!(!contains(bytes, &needle), "{what} is in the Workspace file");
    }
}

#[tokio::test]
async fn every_preset_survives_a_round_trip_without_its_secrets() {
    for preset in Preset::ALL {
        let dir = tempfile::tempdir().unwrap();
        let web = web_dir();
        let db = dir.path().join("first").join("workspace.db");
        let (server, _client, secrets) = used(&db, web.path(), preset).await;

        // Exported while it runs.
        let file = dir.path().join("Exported.infall");
        export_workspace(&db, &file).unwrap();
        server.stop().await;

        let bytes = std::fs::read(&file).unwrap();
        assert!(bytes.starts_with(b"SQLite format 3\0"));
        assert_no_secrets(&bytes, &secrets);
        assert_no_secrets_in_any_table(&file, &secrets);
        // The needles are real: the Workspace's own database holds them.
        let mut original = std::fs::read(&db).unwrap();
        original.extend(std::fs::read(db.with_extension("db-wal")).unwrap_or_default());
        for needle in [
            token_hash(&secrets.session).into_bytes(),
            token_hash(&secrets.access_token).into_bytes(),
            secrets.ciphertext.clone(),
            secrets.password_hash.clone().into_bytes(),
        ] {
            assert!(contains(&original, &needle));
        }
        // Nothing of the copy is left beside the database.
        let left: Vec<String> = std::fs::read_dir(db.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("export"))
            .collect();
        assert!(left.is_empty(), "{left:?}");
        let conn = rusqlite::Connection::open(&file).unwrap();
        let app_id: i32 = conn
            .query_row("PRAGMA application_id", [], |r| r.get(0))
            .unwrap();
        assert_eq!(app_id, APPLICATION_ID);
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        drop(conn);
        for table in ["sessions", "invites", "access_tokens", "ai_settings"] {
            assert_eq!(count(&file, table), 0, "{table}");
        }

        let second = dir.path().join("second").join("workspace.db");
        let imported = import_workspace(&file, &second).unwrap();
        assert_eq!(imported.preset, Some(preset));
        // The file is left as it was.
        assert_eq!(std::fs::read(&file).unwrap(), bytes);

        let before = contents(&db);
        let after = contents(&second);
        assert_eq!(before, after, "{}", preset.id());
        let store = SqliteStore::open(&second).unwrap();
        let member = store.members().unwrap().remove(0);
        assert_eq!(store.ai_settings(member.id).unwrap(), Default::default());
        assert!(store.access_tokens(member.id).unwrap().is_empty());
        drop(store);
        assert_eq!(count(&second, "sessions"), 0);
        assert!(!secret_key_path(&second).exists());

        // `start_local` opens it like any database: the Member and their name are kept, the
        // Preset and name given now are ignored, and nothing is seeded again.
        let server = start(&second, web.path(), Preset::Blank, "Somebody Else").await;
        let c = Client::enter(&server).await;
        let me = c.get("/api/me").await;
        assert_eq!(me["member"]["name"], "Ada Lovelace");
        assert_eq!(me["member"]["id"], before["members"][0]["id"]);
        assert_eq!(
            c.get("/api/workspace").await,
            json!({ "kind": "local", "preset": preset.id(), "empty": false, "read_only": false })
        );
        assert_eq!(
            c.get("/api/local/tutorial").await,
            json!({ "state": { "step": 4 } })
        );
        let ai = c.get("/api/ai/status").await;
        assert_eq!(ai, json!({ "enabled": true }));
        assert_eq!(c.get("/api/tokens").await, json!({ "tokens": [] }));
        // And it can be written to.
        let main = c.main_branch().await;
        c.ok(
            reqwest::Method::POST,
            &format!("/api/branches/{main}/ops"),
            json!({ "ops": [create_card(&new_id(), "Made after the import")] }),
        )
        .await;
        server.stop().await;
        let mut changed = contents(&second);
        assert_ne!(changed["workspace"], before["workspace"]);
        changed["workspace"] = before["workspace"].clone();
        assert_eq!(changed, before);
    }
}

#[tokio::test]
async fn an_export_while_the_workspace_is_written_to_is_a_consistent_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let web = web_dir();
    let db = dir.path().join("ws").join("workspace.db");
    let server = start(&db, web.path(), Preset::Blank, "Ada").await;
    let c = Client::enter(&server).await;
    let main = c.main_branch().await;

    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let writer = {
        let stop = stop.clone();
        let c = Client {
            http: c.http.clone(),
            origin: c.origin.clone(),
            cookie: c.cookie.clone(),
            session: c.session.clone(),
        };
        let main = main.clone();
        tokio::spawn(async move {
            let mut written = 0usize;
            while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                let ops: Vec<Value> = (0..20)
                    .map(|i| create_card(&new_id(), &format!("Card {written} {i}")))
                    .collect();
                c.ok(
                    reqwest::Method::POST,
                    &format!("/api/branches/{main}/ops"),
                    json!({ "ops": ops }),
                )
                .await;
                written += 1;
            }
            written
        })
    };

    let mut files: Vec<PathBuf> = Vec::new();
    for i in 0..4 {
        tokio::time::sleep(Duration::from_millis(60)).await;
        let file = dir.path().join(format!("snapshot-{i}.infall"));
        let (db, file2) = (db.clone(), file.clone());
        tokio::task::spawn_blocking(move || export_workspace(&db, &file2))
            .await
            .unwrap()
            .unwrap();
        files.push(file);
    }
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    let batches = writer.await.unwrap();
    assert!(batches > 0);
    server.stop().await;

    let mut last = 0;
    for (i, file) in files.iter().enumerate() {
        let target = dir
            .path()
            .join(format!("imported-{i}"))
            .join("workspace.db");
        import_workspace(file, &target).unwrap();
        let store = SqliteStore::open(&target).unwrap();
        let ws = store.load_workspace().unwrap().unwrap();
        let branch = ws.branches().next().unwrap();
        let changes = branch.changes().len();
        // Whole batches only: a snapshot never holds part of one.
        assert_eq!(changes % 20, 0, "snapshot {i} has {changes} Changes");
        assert!(changes >= last, "snapshots go forward");
        last = changes;
    }
    let final_store = SqliteStore::open(&db).unwrap();
    let total = final_store
        .load_workspace()
        .unwrap()
        .unwrap()
        .branches()
        .next()
        .unwrap()
        .changes()
        .len();
    assert!(total >= last);
}

#[tokio::test]
async fn a_file_from_a_newer_version_is_refused_and_nothing_is_left() {
    let dir = tempfile::tempdir().unwrap();
    let web = web_dir();
    let db = dir.path().join("ws").join("workspace.db");
    start(&db, web.path(), Preset::Tutorial, "Ada")
        .await
        .stop()
        .await;
    let file = dir.path().join("newer.infall");
    export_workspace(&db, &file).unwrap();
    {
        let conn = rusqlite::Connection::open(&file).unwrap();
        conn.execute_batch(&format!("PRAGMA user_version = {}", SCHEMA_VERSION + 1))
            .unwrap();
    }
    let target = dir.path().join("new").join("workspace.db");
    assert_eq!(
        import_workspace(&file, &target),
        Err(PortError::NewerVersion)
    );
    assert!(!target.exists());
    assert!(!dir.path().join("new").join("workspace.db-journal").exists());
    assert!(
        PortError::NewerVersion
            .to_string()
            .contains("newer version")
    );
}

#[tokio::test]
async fn what_is_not_a_workspace_file_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let web = web_dir();
    let target = dir.path().join("new").join("workspace.db");
    let refuse = |file: &Path| {
        let got = import_workspace(file, &target);
        assert!(!target.exists(), "{}", file.display());
        got
    };

    // Not SQLite at all.
    let garbage = dir.path().join("garbage.infall");
    std::fs::write(&garbage, b"%PDF-1.7 this is a paper, not a Workspace").unwrap();
    assert_eq!(refuse(&garbage), Err(PortError::NotAWorkspaceFile));
    let short = dir.path().join("short.infall");
    std::fs::write(&short, b"SQLite").unwrap();
    assert_eq!(refuse(&short), Err(PortError::NotAWorkspaceFile));
    let empty = dir.path().join("empty.infall");
    std::fs::write(&empty, b"").unwrap();
    assert_eq!(refuse(&empty), Err(PortError::NotAWorkspaceFile));
    // A SQLite header and garbage after it.
    let fake = dir.path().join("fake.infall");
    let mut bytes = b"SQLite format 3\0".to_vec();
    bytes.extend(std::iter::repeat_n(0xA5u8, 8192));
    std::fs::write(&fake, &bytes).unwrap();
    assert_eq!(refuse(&fake), Err(PortError::NotAWorkspaceFile));

    // Some other program's SQLite database.
    let other = dir.path().join("other.infall");
    {
        let conn = rusqlite::Connection::open(&other).unwrap();
        conn.execute_batch("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('hi');")
            .unwrap();
    }
    assert_eq!(refuse(&other), Err(PortError::NotAWorkspaceFile));

    // A Local Workspace's database marked as some other program's.
    let db = dir.path().join("ws").join("workspace.db");
    start(&db, web.path(), Preset::Blank, "Ada")
        .await
        .stop()
        .await;
    let marked = dir.path().join("marked.sqlite");
    std::fs::copy(&db, &marked).unwrap();
    rusqlite::Connection::open(&marked)
        .unwrap()
        .execute_batch("PRAGMA application_id = 1234")
        .unwrap();
    assert_eq!(refuse(&marked), Err(PortError::NotAWorkspaceFile));

    // A good file cut short.
    let good = dir.path().join("good.infall");
    export_workspace(&db, &good).unwrap();
    let whole = std::fs::read(&good).unwrap();
    let cut = dir.path().join("cut.infall");
    std::fs::write(&cut, &whole[..whole.len() / 2]).unwrap();
    assert_eq!(refuse(&cut), Err(PortError::NotAWorkspaceFile));

    // A Team Workspace's database, exported: it has no Preset and more than one person.
    let team_db = dir.path().join("team.db");
    {
        let store = SqliteStore::open(&team_db).unwrap();
        create_admin(
            &store,
            "ada@example.org",
            "Ada",
            "a long enough password",
            1,
        )
        .unwrap();
        create_admin(
            &store,
            "bea@example.org",
            "Bea",
            "a long enough password",
            2,
        )
        .unwrap();
        let (_router, _shutdown) = qoop_server::build_app_with(
            qoop_server::config::Config::for_tests(web.path()),
            std::sync::Arc::new(store),
            Clock::manual(0),
        )
        .unwrap();
    }
    // Since M18 its Workspace file is a Team file, which opens as a Local Workspace
    // (docs/specs/team-move.md, decision 6; tests/team_move.rs).
    let team_file = dir.path().join("team.infall");
    export_workspace(&team_db, &team_file).unwrap();
    let from_team = dir.path().join("from-team").join("workspace.db");
    assert_eq!(
        import_workspace(&team_file, &from_team),
        Ok(qoop_server::local::Imported {
            preset: Some(Preset::Blank),
            from_team: true
        })
    );
    // A Team file whose mark is gone is refused, like the database it came from.
    let unmarked = dir.path().join("unmarked.infall");
    std::fs::copy(&team_file, &unmarked).unwrap();
    rusqlite::Connection::open(&unmarked)
        .unwrap()
        .execute_batch("PRAGMA application_id = 0")
        .unwrap();
    assert_eq!(refuse(&unmarked), Err(PortError::NotAWorkspaceFile));

    // A file that is not there.
    let missing = dir.path().join("missing.infall");
    assert!(matches!(refuse(&missing), Err(PortError::Io(_))));

    // And the good one still works.
    assert!(import_workspace(&good, &target).is_ok());
    assert_eq!(
        PortError::NotAWorkspaceFile.to_string(),
        "This file is neither an Infall Workspace file nor the database of a Local Workspace."
    );
}

#[tokio::test]
async fn neither_export_nor_import_writes_over_a_file() {
    let dir = tempfile::tempdir().unwrap();
    let web = web_dir();
    let db = dir.path().join("ws").join("workspace.db");
    start(&db, web.path(), Preset::LiteratureReview, "Ada")
        .await
        .stop()
        .await;

    let taken = dir.path().join("taken.infall");
    std::fs::write(&taken, b"someone's file").unwrap();
    assert_eq!(
        export_workspace(&db, &taken),
        Err(PortError::DestinationExists)
    );
    assert_eq!(std::fs::read(&taken).unwrap(), b"someone's file");

    let file = dir.path().join("ok.infall");
    export_workspace(&db, &file).unwrap();
    assert_eq!(
        export_workspace(&db, &file),
        Err(PortError::DestinationExists)
    );

    let other_db = dir.path().join("other.db");
    std::fs::write(&other_db, b"another Workspace").unwrap();
    assert_eq!(
        import_workspace(&file, &other_db),
        Err(PortError::DestinationExists)
    );
    assert_eq!(std::fs::read(&other_db).unwrap(), b"another Workspace");
    // Importing over the very database it came from is refused too.
    let before = std::fs::read(&db).unwrap();
    assert_eq!(
        import_workspace(&file, &db),
        Err(PortError::DestinationExists)
    );
    assert_eq!(std::fs::read(&db).unwrap(), before);

    // Exporting a database that is not there says so.
    let none = dir.path().join("none.db");
    assert!(matches!(
        export_workspace(&none, &dir.path().join("x.infall")),
        Err(PortError::Io(_))
    ));
    assert!(!dir.path().join("x.infall").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn workspace_files_are_private_to_their_owner() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let web = web_dir();
    let db = dir.path().join("ws").join("workspace.db");
    start(&db, web.path(), Preset::Blank, "Ada")
        .await
        .stop()
        .await;
    let file = dir.path().join("w.infall");
    export_workspace(&db, &file).unwrap();
    let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    let target = dir.path().join("imported.db");
    import_workspace(&file, &target).unwrap();
    let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
}

// ---------------------------------------------------------------- a database copied by hand

/// Every file in `dir` with its bytes, to see that nothing there changed.
fn files_in(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files: Vec<(String, Vec<u8>)> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap())
        .map(|e| {
            (
                e.file_name().to_string_lossy().to_string(),
                std::fs::read(e.path()).unwrap(),
            )
        })
        .collect();
    files.sort();
    files
}

fn wal_of(db: &Path) -> PathBuf {
    let mut name = db.file_name().unwrap().to_os_string();
    name.push("-wal");
    db.with_file_name(name)
}

/// Adds a Checkpoint and a Branch made at it to the running Workspace.
async fn checkpoint_and_branch(c: &Client, name: &str) {
    let branches = c.get("/api/branches").await;
    let main = &branches["branches"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["name"] == "main")
        .unwrap();
    let (id, seq) = (main["id"].as_str().unwrap(), main["seq"].as_u64().unwrap());
    c.ok(
        reqwest::Method::POST,
        &format!("/api/branches/{id}/checkpoints"),
        json!({ "name": format!("Checkpoint {name}") }),
    )
    .await;
    c.ok(
        reqwest::Method::POST,
        "/api/branches",
        json!({ "name": format!("branch-{name}"), "from": { "branch": id, "seq": seq } }),
    )
    .await;
}

/// What is in an imported Workspace's database: only the kept settings, the mark, no
/// secrets, nothing beside it.
fn assert_clean_import(imported: &Path, secrets: &Secrets) {
    let mut bytes = std::fs::read(imported).unwrap();
    assert!(!wal_of(imported).exists());
    bytes.extend(std::fs::read(wal_of(imported)).unwrap_or_default());
    assert_no_secrets(&bytes, secrets);
    assert_no_secrets_in_any_table(imported, secrets);
    let conn = rusqlite::Connection::open(imported).unwrap();
    let app_id: i32 = conn
        .query_row("PRAGMA application_id", [], |r| r.get(0))
        .unwrap();
    assert_eq!(app_id, APPLICATION_ID);
    let settings: Vec<String> = conn
        .prepare("SELECT name FROM settings ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(settings, ["preset", "tutorial_state"]);
    drop(conn);
    for table in ["sessions", "invites", "access_tokens", "ai_settings"] {
        assert_eq!(count(imported, table), 0, "{table}");
    }
    let left: Vec<String> = std::fs::read_dir(imported.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|n| n.contains("import"))
        .collect();
    assert!(left.is_empty(), "{left:?}");
}

/// Opens the imported Workspace and checks it is the one it came from: its Member, its
/// Preset, its Tutorial progress, and a cookie of its own.
async fn opens_as_the_original(
    imported: &Path,
    web: &Path,
    original: &Value,
    original_cookie: &str,
) {
    let server = start(imported, web, Preset::Blank, "Somebody Else").await;
    let c = Client::enter(&server).await;
    let me = c.get("/api/me").await;
    assert_eq!(me["member"]["name"], "Ada Lovelace");
    assert_eq!(me["member"]["id"], original["members"][0]["id"]);
    assert_eq!(
        c.get("/api/workspace").await,
        json!({ "kind": "local", "preset": "tutorial", "empty": false, "read_only": false })
    );
    assert_eq!(c.get("/api/tokens").await, json!({ "tokens": [] }));
    let name = c.cookie.split('=').next().unwrap();
    assert_ne!(name, original_cookie.split('=').next().unwrap());
    server.stop().await;
}

#[tokio::test]
async fn a_database_copied_by_hand_after_the_app_quit_imports_without_its_secrets() {
    let dir = tempfile::tempdir().unwrap();
    let web = web_dir();
    let db = dir.path().join("app").join("workspace.sqlite");
    let (server, c, secrets) = used(&db, web.path(), Preset::Tutorial).await;
    checkpoint_and_branch(&c, "one").await;
    let original_cookie = c.cookie.clone();
    server.stop().await;
    assert!(
        !wal_of(&db).exists(),
        "the app folds its -wal in when it stops"
    );

    // The person copies the database out of the app's data folder.
    let hand = dir.path().join("Desktop");
    std::fs::create_dir_all(&hand).unwrap();
    let copy = hand.join("workspace.sqlite");
    std::fs::copy(&db, &copy).unwrap();
    let before = files_in(&hand);

    let imported = dir.path().join("new").join("workspace.sqlite");
    assert_eq!(
        import_workspace(&copy, &imported),
        Ok(qoop_server::local::Imported {
            preset: Some(Preset::Tutorial),
            from_team: false,
        })
    );
    // The person's files are as they were, and nothing was put beside them.
    assert_eq!(files_in(&hand), before);

    let original = contents(&db);
    assert_eq!(contents(&imported), original);
    let ws = &original["workspace"];
    assert!(ws.to_string().contains("Checkpoint one"));
    assert!(ws.to_string().contains("branch-one"));
    assert!(ws.to_string().contains("Before the tutorial"));
    assert!(ws.to_string().contains("longer-walks"));
    assert!(original["todos"].as_array().unwrap().len() >= 2);
    assert_clean_import(&imported, &secrets);
    opens_as_the_original(&imported, web.path(), &original, &original_cookie).await;
}

#[tokio::test]
async fn a_database_copied_by_hand_while_the_app_runs_keeps_what_is_in_its_wal() {
    let dir = tempfile::tempdir().unwrap();
    let web = web_dir();
    let db = dir.path().join("app").join("workspace.sqlite");
    let (server, c, secrets) = used(&db, web.path(), Preset::Tutorial).await;
    checkpoint_and_branch(&c, "two").await;
    let main = c.main_branch().await;
    c.ok(
        reqwest::Method::POST,
        &format!("/api/branches/{main}/ops"),
        json!({ "ops": [create_card(&new_id(), "Only in the wal")] }),
    )
    .await;
    // While it runs, the newest Changes are only in the -wal beside the database.
    let wal = wal_of(&db);
    assert!(wal.is_file() && std::fs::metadata(&wal).unwrap().len() > 0);

    let hand = dir.path().join("Desktop");
    std::fs::create_dir_all(&hand).unwrap();
    let copy = hand.join("workspace.sqlite");
    std::fs::copy(&db, &copy).unwrap();
    std::fs::copy(&wal, wal_of(&copy)).unwrap();
    let before = files_in(&hand);

    let imported = dir.path().join("new").join("workspace.sqlite");
    let got = import_workspace(&copy, &imported).unwrap();
    assert_eq!(got.preset, Some(Preset::Tutorial));
    assert_eq!(files_in(&hand), before, "the person's files are untouched");

    let original = contents(&db);
    assert_eq!(contents(&imported), original);
    let ws = original["workspace"].to_string();
    for needle in [
        "Only in the wal",
        "Checkpoint two",
        "branch-two",
        "longer-walks",
    ] {
        assert!(ws.contains(needle), "{needle}");
    }
    assert_clean_import(&imported, &secrets);

    // Without its -wal the copy lacks the newest Changes: the -wal is what brought them.
    let alone = dir.path().join("alone");
    std::fs::create_dir_all(&alone).unwrap();
    std::fs::copy(&db, alone.join("workspace.sqlite")).unwrap();
    let target = dir.path().join("alone-imported").join("workspace.sqlite");
    match import_workspace(&alone.join("workspace.sqlite"), &target) {
        Err(_) => assert!(!target.exists()),
        Ok(_) => assert_ne!(contents(&target), original),
    }

    let original_cookie = c.cookie.clone();
    server.stop().await;
    opens_as_the_original(&imported, web.path(), &original, &original_cookie).await;
}

#[tokio::test]
async fn a_team_database_copied_by_hand_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let web = web_dir();
    for people in [1, 2] {
        let team_db = dir.path().join(format!("team-{people}.sqlite"));
        {
            let store = SqliteStore::open(&team_db).unwrap();
            for i in 0..people {
                create_admin(
                    &store,
                    &format!("admin{i}@example.org"),
                    "Ada",
                    "a long enough password",
                    1,
                )
                .unwrap();
            }
            let (_router, _shutdown) = qoop_server::build_app_with(
                qoop_server::config::Config::for_tests(web.path()),
                std::sync::Arc::new(store),
                Clock::manual(0),
            )
            .unwrap();
        }
        let before = std::fs::read(&team_db).unwrap();
        let target = dir.path().join("new").join("workspace.sqlite");
        assert_eq!(
            import_workspace(&team_db, &target),
            Err(PortError::NotAWorkspaceFile)
        );
        assert!(!target.exists());
        assert_eq!(std::fs::read(&team_db).unwrap(), before);
        let left: Vec<String> = std::fs::read_dir(dir.path().join("new"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert!(left.is_empty(), "{left:?}");
    }
}
