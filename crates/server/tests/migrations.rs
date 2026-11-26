//! Every schema version this codebase ever released opens in the current build: content,
//! history, Checkpoints, Branches, To-dos, Members and settings survive the migration, a
//! copy of the old file is kept beside it until the migration has succeeded, and the files
//! of the old layout still import.
//!
//! The fixtures in `tests/fixtures/` are copied before use, never opened in place:
//!
//! - `v5.sqlite`, `v5.infall`: a Tutorial Local Workspace made and used by the M15 build
//!   (schema version 5, the last with the Workspace as one JSON row) through its HTTP API —
//!   an OpenRouter key (fake), a model, an access token, the Tutorial's progress, Cards, a
//!   Connection, a Page Block, a Source and its Attachment, a To-do on a Card, a Checkpoint,
//!   a Branch `side-idea` edited and merged back with a Conflict decided and a Checkpoint,
//!   a Delete undone by a Restore — then its database (`VACUUM INTO`) and its export.
//! - `v6.sqlite`, `v6.infall`: `v5.sqlite` as the M15 follow-up build (schema version 6,
//!   Research Content as rows of Changes) migrated it, and that build's export of it.
//! - `v7.sqlite`, `v7.infall`: `v6.sqlite` as the M18 build (schema version 7: Comments,
//!   Members as names) migrated it, with a Comment written on a Card and its thread
//!   resolved through that build's store, and that build's export of it.
//! - `v1.sqlite` … `v4.sqlite`: that database taken back to each older schema, as the
//!   releases of M1 (1), M4 (2), M5 (3) and M7 (4) left their files: the tables a version
//!   did not have yet dropped (`settings` before 5, `ai_settings` before 4, `access_tokens`
//!   and `suggestions` before 3, `todos` before 2), one pending invite added, and
//!   `user_version` set. Every step of the schema is unchanged since its release (they are
//!   only ever appended), so these are the files those versions wrote.

mod common;

use std::path::{Path, PathBuf};

use infall_core::{Origin, Workspace};
use infall_server::local::{LocalOptions, Preset, export_workspace, import_workspace, start_local};
use infall_server::store::{SCHEMA_VERSION, SqliteStore, Store, migration_copy_path};
use rusqlite::types::Value as Cell;
use serde_json::{Value, json};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

/// A copy of the fixture in a new folder.
fn copy_of(name: &str, dir: &Path) -> PathBuf {
    let to = dir.join(name);
    std::fs::copy(fixture(name), &to).unwrap();
    to
}

fn version(db: &Path) -> i64 {
    rusqlite::Connection::open(db)
        .unwrap()
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap()
}

fn tables(conn: &rusqlite::Connection) -> Vec<String> {
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .unwrap();
    stmt.query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

/// Every row of every table, as stored, by table.
fn rows(db: &Path) -> Vec<(String, Vec<Vec<Cell>>)> {
    let conn = rusqlite::Connection::open(db).unwrap();
    tables(&conn)
        .into_iter()
        .map(|t| {
            let mut stmt = conn
                .prepare(&format!("SELECT * FROM {t} ORDER BY 1, 2"))
                .unwrap();
            let n = stmt.column_count();
            let rows = stmt
                .query_map([], |r| (0..n).map(|i| r.get::<_, Cell>(i)).collect())
                .unwrap()
                .collect::<Result<Vec<Vec<Cell>>, _>>()
                .unwrap();
            (t, rows)
        })
        .collect()
}

/// The Workspace in a file of the old layout, read as those versions did.
fn old_workspace(db: &Path) -> Workspace {
    let conn = rusqlite::Connection::open(db).unwrap();
    let json: String = conn
        .query_row("SELECT json FROM workspace WHERE id = 1", [], |r| r.get(0))
        .unwrap();
    serde_json::from_str(&json).unwrap()
}

/// What the fixtures hold, checked so that the comparisons below are about something.
fn assert_rich(ws: &Workspace) {
    let main = ws.branch_by_name("main").unwrap();
    let side = ws.branch_by_name("side-idea").unwrap();
    assert!(main.changes().len() > 30, "{}", main.changes().len());
    assert!(!side.changes().is_empty());
    let origins: Vec<&Origin> = main.changes().iter().map(|c| &c.origin).collect();
    assert!(origins.iter().any(|o| matches!(o, Origin::Merge { .. })));
    assert!(origins.iter().any(|o| matches!(o, Origin::Restore { .. })));
    assert!(side.sync_points().iter().any(|p| p.landed.is_some()));
    let names: Vec<&str> = ws
        .checkpoints(main.id())
        .iter()
        .map(|c| c.name.as_str())
        .collect();
    assert!(names.contains(&"Before the upgrade"), "{names:?}");
    assert!(names.contains(&"Before merging side-idea"), "{names:?}");
}

/// The tables schema version 7 added.
const V7_TABLES: [&str; 3] = ["comment_threads", "comments", "for_you"];
/// The tables schema version 8 added (stored PDFs and their text).
const V8_TABLES: [&str; 3] = ["pdf_chunks", "pdf_files", "pdf_text"];

#[test]
fn a_file_of_every_released_schema_version_upgrades_and_keeps_everything() {
    for old in 1..=7i64 {
        let dir = tempfile::tempdir().unwrap();
        let name = format!("v{old}.sqlite");
        let db = copy_of(&name, dir.path());
        assert_eq!(version(&db), old);
        // Versions 6 and 7 have no JSON row; they were made from the version 5 file.
        let before_ws = if old < 6 {
            old_workspace(&db)
        } else {
            old_workspace(&fixture("v5.sqlite"))
        };
        assert_rich(&before_ws);
        let before_rows = rows(&db);

        let store = SqliteStore::open(&db).unwrap();
        let ws = store.load_workspace().unwrap().unwrap();
        // Content and history: every Branch, Change, Checkpoint and sync point, exactly.
        assert_eq!(ws, before_ws, "v{old}");
        assert_eq!(
            serde_json::to_value(&ws).unwrap(),
            serde_json::to_value(&before_ws).unwrap()
        );
        assert_eq!(version(&db), SCHEMA_VERSION);
        // The safety copy is gone once the migration succeeded.
        assert!(!migration_copy_path(&db, old).exists(), "v{old}");

        // Every other table is as it was, row for row: Members, sessions, invites, To-dos,
        // access tokens, Suggestions, AI settings, settings — whichever the version had.
        let after_rows = rows(&db);
        let names = |r: &[(String, Vec<Vec<Cell>>)]| -> Vec<String> {
            r.iter().map(|(t, _)| t.clone()).collect()
        };
        let mut expected_tables = names(&before_rows);
        expected_tables.retain(|t| t != "workspace");
        for t in [
            "branches",
            "changes",
            "checkpoints",
            "sync_points",
            "todos",
            "access_tokens",
            "suggestions",
            "ai_settings",
            "settings",
        ]
        .into_iter()
        .chain(V7_TABLES)
        .chain(V8_TABLES)
        {
            if !expected_tables.iter().any(|x| x == t) {
                expected_tables.push(t.to_string());
            }
        }
        expected_tables.sort();
        assert_eq!(names(&after_rows), expected_tables, "v{old}");
        for (table, before) in &before_rows {
            if table == "workspace" {
                continue;
            }
            let mut after = after_rows
                .iter()
                .find(|(t, _)| t == table)
                .unwrap()
                .1
                .clone();
            if table == "invites" && old < 7 {
                // Version 7 added `claims`, null for every invite there was.
                for row in &mut after {
                    assert_eq!(row.pop(), Some(Cell::Null), "v{old}");
                }
            }
            assert_eq!(&after, before, "v{old}: {table}");
            let used = [
                "members",
                "todos",
                "access_tokens",
                "suggestions",
                "ai_settings",
            ];
            if used.contains(&table.as_str())
                || table == "settings"
                || (old < 5 && table == "invites")
            {
                assert!(!before.is_empty(), "v{old}: {table} is empty");
            }
        }

        let new_tables = V8_TABLES.iter().chain(V7_TABLES.iter().filter(|_| old < 7));
        for t in new_tables {
            let empty = after_rows.iter().find(|(name, _)| name == t).unwrap();
            assert!(empty.1.is_empty(), "v{old}: {t}");
        }
        if old == 7 {
            for t in ["comments", "comment_threads"] {
                let kept = after_rows.iter().find(|(name, _)| name == t).unwrap();
                assert_eq!(kept.1.len(), 1, "v7: {t}");
            }
        }

        // And through the store, as the server reads them.
        let members = store.members().unwrap();
        assert_eq!(members.len(), 1);
        assert_eq!(members[0].name, "Ada Lovelace");
        assert!(members[0].claimed());
        assert!(store.comments(uuid::Uuid::new_v4()).unwrap().1.is_empty());
        assert_eq!(store.comment_total().unwrap(), usize::from(old == 7));
        assert!(store.pdf_file(&"0".repeat(64)).unwrap().is_none());
        assert_eq!(
            infall_server::local::file_stats(&db).unwrap(),
            infall_server::local::FileStats::default()
        );
        if old >= 2 {
            let todos = store.todos().unwrap();
            assert!(todos.iter().any(|t| t.text == "Check the upgrade"));
        }
        if old >= 3 {
            assert_eq!(store.access_tokens(members[0].id).unwrap().len(), 1);
        }
        if old >= 4 {
            let ai = store.ai_settings(members[0].id).unwrap();
            assert!(ai.key.is_some());
            assert_eq!(ai.model.as_deref(), Some("fake/model-1"));
        }
        if old >= 5 {
            assert_eq!(
                store.setting("preset").unwrap().as_deref(),
                Some("tutorial")
            );
            assert!(store.setting("tutorial_state").unwrap().is_some());
        }
        drop(store);

        // Opening it again migrates nothing and changes nothing.
        let again_rows = rows(&db);
        let store = SqliteStore::open(&db).unwrap();
        assert_eq!(store.load_workspace().unwrap().unwrap(), before_ws);
        drop(store);
        assert_eq!(rows(&db), again_rows);
    }
}

#[test]
fn a_migration_that_fails_leaves_the_file_as_it_was_and_its_copy_beside_it() {
    let dir = tempfile::tempdir().unwrap();
    let db = copy_of("v5.sqlite", dir.path());
    let good: String = {
        let conn = rusqlite::Connection::open(&db).unwrap();
        let json: String = conn
            .query_row("SELECT json FROM workspace", [], |r| r.get(0))
            .unwrap();
        // A Workspace this build cannot read.
        conn.execute("UPDATE workspace SET json = '{\"branches\": 7}'", [])
            .unwrap();
        json
    };
    let before = rows(&db);

    let refused = SqliteStore::open(&db).err().expect("the migration fails");
    let copy = migration_copy_path(&db, 5);
    assert!(
        refused.to_string().contains(&copy.display().to_string()),
        "{refused}"
    );
    assert_eq!(version(&db), 5);
    assert_eq!(rows(&db), before);
    // The copy is the file as it was.
    assert_eq!(rows(&copy), before);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&copy).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    // Once the file can be migrated, the next open does it and removes the copy.
    rusqlite::Connection::open(&db)
        .unwrap()
        .execute("UPDATE workspace SET json = ?1", [&good])
        .unwrap();
    let store = SqliteStore::open(&db).unwrap();
    assert_eq!(
        store.load_workspace().unwrap().unwrap(),
        serde_json::from_str::<Workspace>(&good).unwrap()
    );
    assert!(!copy.exists());
    drop(store);

    // A copy left by a run that stopped between the commit and its removal goes on the
    // next open.
    std::fs::write(&copy, b"left over").unwrap();
    drop(SqliteStore::open(&db).unwrap());
    assert!(!copy.exists());
}

#[test]
fn a_new_database_and_an_in_memory_one_need_no_copy() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("new.db");
    let store = SqliteStore::open(&db).unwrap();
    assert!(store.load_workspace().unwrap().is_none());
    drop(store);
    assert_eq!(version(&db), SCHEMA_VERSION);
    let left: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|n| n.contains("backup"))
        .collect();
    assert!(left.is_empty(), "{left:?}");
    let conn = rusqlite::Connection::open(&db).unwrap();
    assert!(!tables(&conn).contains(&"workspace".to_string()));
    drop(conn);
    let memory = SqliteStore::open_in_memory().unwrap();
    assert!(memory.load_workspace().unwrap().is_none());
}

// ---------------------------------------------------------------- the old files, imported

struct Client {
    http: reqwest::Client,
    origin: String,
    cookie: String,
}

impl Client {
    async fn enter(server: &infall_server::local::LocalServer) -> Client {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let res = http.get(server.entry_url()).send().await.unwrap();
        let cookie = res.headers()[reqwest::header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string();
        Client {
            http,
            origin: server.origin().to_string(),
            cookie,
        }
    }

    async fn send(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Value {
        let mut req = self
            .http
            .request(method.clone(), format!("{}{path}", self.origin))
            .header(reqwest::header::COOKIE, &self.cookie)
            .header(reqwest::header::ORIGIN, &self.origin)
            .header("x-infall-request", "1");
        if let Some(body) = body {
            req = req.json(&body);
        }
        let res = req.send().await.unwrap();
        let status = res.status();
        let text = res.text().await.unwrap();
        assert!(status.is_success(), "{method} {path}: {status} {text}");
        serde_json::from_str(&text).unwrap_or(Value::Null)
    }

    async fn get(&self, path: &str) -> Value {
        self.send(reqwest::Method::GET, path, None).await
    }

    async fn post(&self, path: &str, body: Value) -> Value {
        self.send(reqwest::Method::POST, path, Some(body)).await
    }
}

async fn start(db: &Path, web: &Path) -> infall_server::local::LocalServer {
    start_local(LocalOptions {
        db: db.to_path_buf(),
        web_dir: web.to_path_buf(),
        preset: Preset::Blank,
        member_name: "Somebody Else".to_string(),
        port: None,
        read_only: false,
        moved_to: None,
    })
    .await
    .unwrap()
}

/// What the web UI reads of a Workspace's history, by Branch name.
async fn history(c: &Client) -> Value {
    let branches = c.get("/api/branches").await;
    let mut out = serde_json::Map::new();
    for b in branches["branches"].as_array().unwrap() {
        let id = b["id"].as_str().unwrap();
        out.insert(
            b["name"].as_str().unwrap().to_string(),
            json!({
                "branch": b,
                "changes": c.get(&format!("/api/branches/{id}/changes?after=0")).await,
                "checkpoints": c.get(&format!("/api/branches/{id}/checkpoints")).await,
                "board": c.get(&format!("/api/branches/{id}/board")).await,
                "board_at_1": c.get(&format!("/api/branches/{id}/board?at=1")).await,
            }),
        );
    }
    out.insert("graph".to_string(), c.get("/api/graph").await);
    Value::Object(out)
}

#[tokio::test]
async fn workspace_files_and_databases_of_the_old_layout_import_and_read_the_same() {
    let web = common::web_dir();
    let dir = tempfile::tempdir().unwrap();
    // As the M15 build read it, through the same requests (taken on a copy upgraded in
    // place, the way the desktop app opens a Local Workspace it already has).
    let in_place = copy_of("v5.sqlite", dir.path());
    let expected_ws = old_workspace(&in_place);

    for (i, file) in [
        "v5.infall",
        "v5.sqlite",
        "v6.infall",
        "v6.sqlite",
        "v7.infall",
        "v7.sqlite",
    ]
    .into_iter()
    .enumerate()
    {
        let target = dir
            .path()
            .join(format!("imported-{i}"))
            .join("workspace.db");
        let imported = import_workspace(&fixture(file), &target).unwrap();
        assert_eq!(imported.preset, Some(Preset::Tutorial), "{file}");
        assert!(!imported.from_team);
        // Imported as it is; the first open migrates it.
        let was: i64 = file[1..2].parse().unwrap();
        assert_eq!(version(&target), was);
        let server = start(&target, web.path()).await;
        assert!(!migration_copy_path(&target, was).exists());
        let c = Client::enter(&server).await;
        let read = history(&c).await;
        let main = read["main"]["branch"]["id"].as_str().unwrap().to_string();
        let side = read["side-idea"]["branch"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(
            read["main"]["changes"]["changes"].as_array().unwrap().len(),
            expected_ws.branch_by_name("main").unwrap().changes().len()
        );
        let plan = c
            .get(&format!("/api/merges/plan?source={side}&target={main}"))
            .await;
        assert!(plan["plan"].is_object(), "{plan}");
        // It goes on being written to: an edit and a Restore, kept across a restart.
        let card = common::new_id();
        c.post(
            &format!("/api/branches/{main}/ops"),
            json!({ "ops": [common::create_card(&card, "After the upgrade")] }),
        )
        .await;
        let seq = c.get("/api/branches").await["branches"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["name"] == "main")
            .unwrap()["seq"]
            .as_u64()
            .unwrap();
        c.post(
            &format!("/api/branches/{main}/restore"),
            json!({ "to_seq": seq - 1 }),
        )
        .await;
        let written = history(&c).await;
        server.stop().await;
        let server = start(&target, web.path()).await;
        let c = Client::enter(&server).await;
        assert_eq!(history(&c).await, written, "{file}");
        server.stop().await;

        // The upgraded file is what the old one was, plus the two writes.
        let store = SqliteStore::open(&target).unwrap();
        let ws = store.load_workspace().unwrap().unwrap();
        for b in expected_ws.branches() {
            let now = ws.branch(b.id()).unwrap();
            assert_eq!(now.changes()[..b.changes().len()], *b.changes());
            assert_eq!(now.recorded_checkpoints(), b.recorded_checkpoints());
        }
    }

    // And what the Workspace reads as over HTTP is the same, imported or upgraded in place.
    let server = start(&in_place, web.path()).await;
    let c = Client::enter(&server).await;
    let read_in_place = history(&c).await;
    server.stop().await;
    let target = dir.path().join("third").join("workspace.db");
    import_workspace(&fixture("v5.infall"), &target).unwrap();
    let server = start(&target, web.path()).await;
    let c = Client::enter(&server).await;
    assert_eq!(history(&c).await, read_in_place);
    server.stop().await;
}

#[test]
fn a_file_of_the_new_layout_exports_and_imports_from_its_tables() {
    let dir = tempfile::tempdir().unwrap();
    let db = copy_of("v5.sqlite", dir.path());
    let expected = old_workspace(&db);
    drop(SqliteStore::open(&db).unwrap());
    let file = dir.path().join("new-layout.infall");
    export_workspace(&db, &file).unwrap();
    assert_eq!(version(&file), SCHEMA_VERSION);
    let target = dir.path().join("back").join("workspace.db");
    import_workspace(&file, &target).unwrap();
    let store = SqliteStore::open(&target).unwrap();
    assert_eq!(store.load_workspace().unwrap().unwrap(), expected);

    // A file of the new layout whose tables do not read is no Workspace file.
    let broken = dir.path().join("broken.infall");
    std::fs::copy(&file, &broken).unwrap();
    rusqlite::Connection::open(&broken)
        .unwrap()
        .execute("UPDATE changes SET op = 'not an op' WHERE seq = 1", [])
        .unwrap();
    assert_eq!(
        import_workspace(&broken, &dir.path().join("x").join("workspace.db")),
        Err(infall_server::local::PortError::NotAWorkspaceFile)
    );
}
