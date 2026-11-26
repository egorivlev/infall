//! M18 — from alone to a team (docs/specs/team-move.md; api.md §19): a Local Workspace's
//! file brought into an empty Team Workspace, a Team Workspace's file into another one and
//! into a Local Workspace, Members who are names only and the invites that claim them, a
//! moved Local Workspace that is read-only, and the two command-line subcommands.

mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use common::{ORIGIN, PASSWORD, START, TestApp, create, create_card, new_id, web_dir};
use http_body_util::BodyExt;
use infall_server::Clock;
use infall_server::auth::token_hash;
use infall_server::local::{
    LocalOptions, Preset, build_local_app_with, export_workspace, import_workspace, local_config,
    start_local,
};
use infall_server::secret::SecretKey;
use infall_server::store::{SCHEMA_VERSION, SqliteStore, Store};
use serde_json::{Value, json};
use tower::ServiceExt;

// ---------------------------------------------------------------- harness

/// A Team Workspace on a database file (an import needs one), whose `config.db` is that file.
fn team(dir: &Path, name: &str, tweak: impl FnOnce(&mut infall_server::config::Config)) -> TestApp {
    let db = dir.join(format!("{name}.db"));
    let store: Arc<dyn Store> = Arc::new(SqliteStore::open(&db).unwrap());
    TestApp::with_config(store, |c| {
        c.db = db.clone();
        tweak(c);
    })
}

/// An Admin of `email` on `app`, signed in.
async fn admin_as(app: &TestApp, email: &str, name: &str) -> String {
    infall_server::create_admin(&*app.store, email, name, PASSWORD, START).unwrap();
    let res = app.login(email, PASSWORD).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    res.cookie()
}

async fn me(app: &TestApp, cookie: &str) -> String {
    app.get("/api/me", Some(cookie)).await.body["member"]["id"]
        .as_str()
        .unwrap()
        .to_string()
}

/// A request with a body of bytes, answered as bytes.
async fn bytes(
    app: &TestApp,
    method: Method,
    path: &str,
    cookie: Option<&str>,
    body: Vec<u8>,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut b = Request::builder()
        .method(method)
        .uri(path)
        .header(header::ORIGIN, ORIGIN)
        .header("x-infall-request", "1")
        .header(header::CONTENT_TYPE, "application/octet-stream");
    if let Some(c) = cookie {
        b = b.header(header::COOKIE, c);
    }
    let res = app
        .router
        .clone()
        .oneshot(b.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let body = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    (status, headers, body)
}

async fn upload(app: &TestApp, cookie: &str, file: Vec<u8>) -> (StatusCode, Value) {
    let (status, _, body) = bytes(
        app,
        Method::POST,
        "/api/workspace/import",
        Some(cookie),
        file,
    )
    .await;
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

async fn download(app: &TestApp, cookie: &str) -> Vec<u8> {
    let (status, headers, body) = bytes(
        app,
        Method::GET,
        "/api/workspace/export",
        Some(cookie),
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    assert_eq!(headers[header::CONTENT_TYPE], "application/octet-stream");
    assert_eq!(
        headers[header::CONTENT_DISPOSITION],
        "attachment; filename=\"localhost-8787.infall\""
    );
    body
}

/// A Local Workspace on a database file, driven without a socket (see tests/local.rs).
struct LocalWs {
    app: TestApp,
    key: String,
}

fn local_ws(db: &Path, preset: Preset, name: &str, read_only: bool) -> LocalWs {
    let store: Arc<dyn Store> = Arc::new(SqliteStore::open(db).unwrap());
    let web = web_dir();
    let mut config = local_config(([127, 0, 0, 1], 4321).into(), web.path().to_path_buf());
    config.dev_origin = Some(ORIGIN.to_string());
    config.db = db.to_path_buf();
    let clock = Clock::manual(START);
    let built = build_local_app_with(
        config,
        store.clone(),
        clock.clone(),
        preset,
        name,
        read_only,
        read_only.then(|| "https://team.example.org".to_string()),
    )
    .unwrap();
    LocalWs {
        app: TestApp {
            router: built.router,
            clock,
            store,
            web,
        },
        key: built.entry_key,
    }
}

impl LocalWs {
    async fn enter(&self) -> String {
        let res = self
            .app
            .get(&format!("/api/local/enter?key={}", self.key), None)
            .await;
        assert_eq!(res.status, StatusCode::SEE_OTHER, "{}", res.text);
        res.cookie()
    }
}

/// Everything History shows, by Branch name, as text: the Changes, Checkpoints and Branch
/// list of every Branch, and the Branch Graph.
async fn history(app: &TestApp, cookie: &str) -> String {
    let branches = app.get("/api/branches", Some(cookie)).await.body;
    let mut out = serde_json::Map::new();
    for b in branches["branches"].as_array().unwrap() {
        let id = b["id"].as_str().unwrap();
        out.insert(
            b["name"].as_str().unwrap().to_string(),
            json!({
                "branch": b,
                "changes": app.get(&format!("/api/branches/{id}/changes"), Some(cookie)).await.body,
                "checkpoints": app.get(&format!("/api/branches/{id}/checkpoints"), Some(cookie)).await.body,
                "board": app.get(&format!("/api/branches/{id}/board"), Some(cookie)).await.body,
            }),
        );
    }
    out.insert(
        "graph".into(),
        app.get("/api/graph", Some(cookie)).await.body,
    );
    Value::Object(out).to_string()
}

async fn main_id(app: &TestApp, cookie: &str) -> String {
    app.main_branch(cookie).await
}

/// A pinned AI answer on `card`'s Page: a Pin by `who`.
fn pin(card: &str, who: &str) -> Value {
    create(
        &new_id(),
        "Block",
        json!({
            "card": { "Ref": card }, "type": { "Text": "text" }, "order": { "Text": "a" },
            "text": { "Text": "What the AI said." }, "ai_model": { "Text": "some/model" },
            "ai_pinned_by": { "Text": who }, "ai_pinned_at": { "Float": 1.0 },
        }),
    )
}

/// A used Tutorial Local Workspace — seeded Changes, Branch, Checkpoint, To-do, a Run with
/// its result, plus a Pin and a Comment of its Member — exported to a Workspace file.
/// Returns the file, the Local Workspace's history, its Member's id and its main's id.
async fn used_local_file(dir: &Path) -> (PathBuf, String, String, String) {
    let db = dir.join("laptop").join("workspace.db");
    std::fs::create_dir_all(db.parent().unwrap()).unwrap();
    let w = local_ws(&db, Preset::Tutorial, "Ada Lovelace", false);
    let c = w.enter().await;
    let member = me(&w.app, &c).await;
    let main = main_id(&w.app, &c).await;
    let card = new_id();
    w.app
        .ops(
            &c,
            &main,
            json!([create_card(&card, "Mine"), pin(&card, &member)]),
        )
        .await;
    let res = w
        .app
        .post(
            &format!("/api/cards/{card}/comments"),
            Some(&c),
            json!({ "text": "A note to myself", "mentions": [member] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.text);
    let seen = history(&w.app, &c).await;
    let file = dir.join("Laptop.infall");
    export_workspace(&db, &file).unwrap();
    (file, seen, member, main)
}

// ---------------------------------------------------------------- Local → Team

#[tokio::test]
async fn a_local_workspace_file_comes_into_an_empty_team_workspace_as_the_admins_work() {
    let dir = tempfile::tempdir().unwrap();
    let (file, local_history, local_member, local_main) = used_local_file(dir.path()).await;
    let app = team(dir.path(), "team", |_| {});
    let admin = app.admin().await;
    app.clock.advance(1);
    let bo = app.join(&admin, "bo@example.org", "member", None).await;
    let admin_id = me(&app, &admin).await;
    let team_main = main_id(&app, &admin).await;
    let ws = app.get("/api/workspace", Some(&bo)).await.body;
    assert_eq!(
        ws,
        json!({ "kind": "team", "preset": null, "empty": true, "read_only": false })
    );
    let bytes_of = std::fs::read(&file).unwrap();

    // Only an Admin.
    let (status, body) = upload(&app, &bo, bytes_of.clone()).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let (status, ..) = bytes(
        &app,
        Method::POST,
        "/api/workspace/import",
        None,
        bytes_of.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, body) = upload(&app, &admin, bytes_of.clone()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["you_were"], "Ada Lovelace");
    let names: Vec<(String, bool)> = body["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["name"].as_str().unwrap().to_string(),
                m["claimed"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        names,
        [("Ada Admin".to_string(), true), ("bo".to_string(), true)]
    );

    // History reads exactly as it did, under the Admin's name: the only differences are the
    // Member's id (now the Admin's) and the id of `main` (the server's own).
    let team_history = history(&app, &admin).await;
    assert!(!team_history.contains(&local_member));
    let expected = local_history
        .replace(&local_member, &admin_id)
        .replace(&local_main, &team_main);
    assert_eq!(team_history, expected);
    assert!(team_history.contains("longer-walks"));
    assert!(team_history.contains("Before the tutorial"));
    // The Pin and the Run's result are the Admin's.
    let board = app
        .get(&format!("/api/branches/{team_main}/board"), Some(&admin))
        .await
        .body;
    let pins: Vec<&Value> = board["entities"]
        .as_object()
        .unwrap()
        .values()
        .filter_map(|e| e["fields"].get("ai_pinned_by"))
        .collect();
    assert_eq!(pins, [&json!({ "Text": admin_id })]);
    assert!(
        board
            .to_string()
            .contains(&format!("\\\"by\\\":\\\"{admin_id}\\\"")),
        "the Run result"
    );

    // To-dos and Comments came along, as the Admin's.
    let todos = app.get("/api/todos", Some(&admin)).await.body;
    assert!(!todos["todos"].as_array().unwrap().is_empty());
    for t in todos["todos"].as_array().unwrap() {
        assert_eq!(t["owner"], admin_id);
        assert_eq!(t["created_by"], admin_id);
    }
    let counts = app.get("/api/comments/counts", Some(&bo)).await.body;
    let (card, count) = counts.as_object().unwrap().iter().next().unwrap();
    assert_eq!(count, &json!({ "open": 1, "resolved": false }));
    let thread = app
        .get(&format!("/api/cards/{card}/comments"), Some(&bo))
        .await
        .body;
    assert_eq!(thread["comments"][0]["author"], admin_id);
    assert_eq!(thread["comments"][0]["mentions"], json!([admin_id]));
    assert_eq!(thread["comments"][0]["text"], "A note to myself");

    // No longer empty: a second file is refused, and nothing changes.
    assert_eq!(
        app.get("/api/workspace", Some(&admin)).await.body["empty"],
        false
    );
    let (status, body) = upload(&app, &admin, bytes_of).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["code"], "not_empty");
    assert_eq!(history(&app, &admin).await, team_history);

    // The new Workspace goes on being written to, and is read back from the database.
    app.ops(&admin, &team_main, json!([create_card(&new_id(), "After")]))
        .await;
    drop(app);
    let store = SqliteStore::open(&dir.path().join("team.db")).unwrap();
    let ws = store.load_workspace().unwrap().unwrap();
    assert!(ws.branch_by_name("longer-walks").is_some());
}

#[tokio::test]
async fn a_file_that_cannot_come_in_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let (file, ..) = used_local_file(dir.path()).await;
    let app = team(dir.path(), "team", |c| c.max_import_bytes = 64 * 1024);
    let admin = app.admin().await;
    let before_members = app.get("/api/members", Some(&admin)).await.body;
    let before = history(&app, &admin).await;
    let good = std::fs::read(&file).unwrap();
    let check = |what: &'static str| {
        let (app, admin, before, before_members) = (&app, &admin, &before, &before_members);
        async move {
            assert_eq!(&history(app, admin).await, before, "{what}");
            assert_eq!(
                &app.get("/api/members", Some(admin)).await.body,
                before_members,
                "{what}"
            );
            assert_eq!(
                app.get("/api/workspace", Some(admin)).await.body["empty"],
                true,
                "{what}"
            );
            assert!(
                app.get("/api/todos", Some(admin)).await.body["todos"]
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
        }
    };

    // Too large for this server.
    let (status, body) = upload(&app, &admin, vec![0u8; 64 * 1024 + 1]).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{body}");
    assert_eq!(body["error"]["code"], "too_large");
    let said = body["error"]["message"].as_str().unwrap();
    assert!(
        said.starts_with(
            "This Workspace file is larger than 0 MB; this server takes at most 0 MB."
        ) && said.contains("INFALL_MAX_IMPORT_MB"),
        "{said}"
    );
    check("too large").await;

    // Not a Workspace file.
    let (status, body) = upload(&app, &admin, b"%PDF-1.7 a paper".to_vec()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "not_a_workspace_file");
    check("garbage").await;

    // Made by a newer version.
    let newer = dir.path().join("newer.infall");
    std::fs::copy(&file, &newer).unwrap();
    rusqlite::Connection::open(&newer)
        .unwrap()
        .execute_batch(&format!("PRAGMA user_version = {}", SCHEMA_VERSION + 1))
        .unwrap();
    let app_big = team(dir.path(), "big", |_| {});
    let big_admin = app_big.admin().await;
    let (status, body) = upload(&app_big, &big_admin, std::fs::read(&newer).unwrap()).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["code"], "newer_version");

    // A file that passes its checks but fails half way in: a To-do of nobody. The whole
    // import is one transaction, so not even the Changes before it stay.
    let broken = dir.path().join("broken.infall");
    std::fs::copy(&file, &broken).unwrap();
    let conn = rusqlite::Connection::open(&broken).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
    conn.execute(
        "INSERT INTO todos (id, owner, text, done, created_by, created_at)
             VALUES (?1, ?2, 'Orphan', 0, ?2, 1)",
        [new_id(), new_id()],
    )
    .unwrap();
    let (status, _) = upload(&app_big, &big_admin, std::fs::read(&broken).unwrap()).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        app_big.get("/api/workspace", Some(&big_admin)).await.body["empty"],
        true
    );
    let branches = app_big.get("/api/branches", Some(&big_admin)).await.body;
    assert_eq!(branches["branches"].as_array().unwrap().len(), 1);
    assert_eq!(branches["branches"][0]["seq"], 0);
    // And the good file still comes in afterwards.
    let (status, body) = upload(&app_big, &big_admin, good.clone()).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // Not empty because of a To-do alone, or a Comment alone.
    let admin_id = me(&app, &admin).await;
    let res = app
        .post(
            "/api/todos",
            Some(&admin),
            json!({ "owner": admin_id, "text": "Set up" }),
        )
        .await;
    let todo = res.body["todo"]["id"].as_str().unwrap().to_string();
    let (status, body) = upload(&app, &admin, good.clone()).await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("not_empty"))
    );
    app.delete(&format!("/api/todos/{todo}"), Some(&admin))
        .await;
    let res = app
        .post(
            &format!("/api/cards/{}/comments", new_id()),
            Some(&admin),
            json!({ "text": "Hello" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::CREATED);
    let (status, _) = upload(&app, &admin, good).await;
    assert_eq!(status, StatusCode::CONFLICT);

    // A Local Workspace has no such route.
    let w = local_ws(&dir.path().join("l.db"), Preset::Blank, "Ada", false);
    let c = w.enter().await;
    let (status, _) = upload(&w.app, &c, std::fs::read(&file).unwrap()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, ..) = bytes(
        &w.app,
        Method::GET,
        "/api/workspace/export",
        Some(&c),
        vec![],
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

// ---------------------------------------------------------------- Team → Team, Team → Local

/// Team A: Ada (Admin), Bo and Di (Members), a Guest; Changes by Ada and Bo, a To-do for Bo,
/// a Comment by Bo mentioning Ada, a Branch; and every secret a Team server holds. Returns
/// the app, Ada's cookie, the ids of Ada, Bo and Di, and the secrets to look for.
struct TeamA {
    app: TestApp,
    ada: String,
    bo: String,
    ada_id: String,
    bo_id: String,
    di_id: String,
    secrets: Vec<(String, Vec<u8>)>,
}

async fn team_a(dir: &Path) -> TeamA {
    let key = SecretKey::generate().unwrap();
    let app = team(dir, "a", |c| c.secret_key = Some(key));
    let ada = app.admin().await;
    app.clock.advance(1);
    let bo = app.join(&ada, "bo@example.org", "member", None).await;
    app.clock.advance(1);
    let di = app.join(&ada, "di@example.org", "member", None).await;
    let guest = app
        .join(&ada, "gus@example.org", "guest", Some(START + 10_000_000))
        .await;
    let (ada_id, bo_id, di_id) = (
        me(&app, &ada).await,
        me(&app, &bo).await,
        me(&app, &di).await,
    );
    let main = main_id(&app, &ada).await;
    let card = new_id();
    app.ops(&ada, &main, json!([create_card(&card, "By Ada")]))
        .await;
    app.ops(&bo, &main, json!([common::set_title(&card, "Bo was here")]))
        .await;
    let seq = app.get("/api/branches", Some(&ada)).await.body["branches"][0]["seq"].clone();
    let res = app
        .post(
            "/api/branches",
            Some(&bo),
            json!({ "name": "bos-idea", "from": { "branch": main, "seq": seq } }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let res = app
        .post(
            "/api/todos",
            Some(&ada),
            json!({ "owner": bo_id, "text": "Read the paper" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    let res = app
        .post(
            &format!("/api/cards/{card}/comments"),
            Some(&bo),
            json!({ "text": "@Ada look", "mentions": [ada_id] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::CREATED);
    // Secrets: an OpenRouter key, an access token, a pending invite.
    let ai_key = "sk-or-v1-TEAMSECRET-0123456789abcdef";
    let res = app
        .put("/api/ai/key", Some(&bo), json!({ "key": ai_key }))
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let token = app.access_token(&bo, "laptop").await;
    let invite = app.invite(&ada, "eve@example.org", "member", None).await;
    let mut secrets: Vec<(String, Vec<u8>)> = vec![
        ("the AI key".into(), ai_key.into()),
        ("the access token".into(), token.clone().into()),
        ("the access token's hash".into(), token_hash(&token).into()),
        ("the invite token".into(), invite.clone().into()),
        ("the invite's hash".into(), token_hash(&invite).into()),
        ("the invited email".into(), b"eve@example.org".to_vec()),
    ];
    for email in [
        "admin@example.org",
        "bo@example.org",
        "di@example.org",
        "gus@example.org",
    ] {
        secrets.push((email.into(), email.into()));
        let m = app.store.member_by_email(email).unwrap().unwrap();
        secrets.push((format!("{email}'s password hash"), m.password_hash.into()));
    }
    for cookie in [&ada, &bo, &di, &guest] {
        let token = cookie.split('=').nth(1).unwrap();
        secrets.push(("a session".into(), token.into()));
        secrets.push(("a session's hash".into(), token_hash(token).into()));
    }
    let bo_member = app
        .store
        .member_by_email("bo@example.org")
        .unwrap()
        .unwrap();
    let sealed = app.store.ai_settings(bo_member.id).unwrap().key.unwrap();
    secrets.push(("the sealed AI key".into(), sealed.ciphertext));
    TeamA {
        app,
        ada,
        bo,
        ada_id,
        bo_id,
        di_id,
        secrets,
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|w| w == needle)
}

#[tokio::test]
async fn a_team_export_holds_names_only_and_nothing_secret() {
    let dir = tempfile::tempdir().unwrap();
    let a = team_a(dir.path()).await;
    let bo_only = a.app.get("/api/workspace/export", Some(&a.bo)).await;
    assert_eq!(bo_only.status, StatusCode::FORBIDDEN);
    let file = download(&a.app, &a.ada).await;
    assert!(file.starts_with(b"SQLite format 3\0"));
    for (what, needle) in &a.secrets {
        assert!(!contains(&file, needle), "{what} is in the Workspace file");
    }
    // The needles are real: the server's database holds them (or, for the plain tokens,
    // they were handed out).
    let db_bytes = std::fs::read(dir.path().join("a.db")).unwrap();
    let mut wal = db_bytes.clone();
    wal.extend(std::fs::read(dir.path().join("a.db-wal")).unwrap_or_default());
    assert!(contains(&wal, b"bo@example.org"));

    // What the file says about itself, and what it holds.
    let path = dir.path().join("check.infall");
    std::fs::write(&path, &file).unwrap();
    let conn = rusqlite::Connection::open(&path).unwrap();
    let settings: Vec<(String, String)> = conn
        .prepare("SELECT name, value FROM settings ORDER BY name")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        settings,
        [
            ("exported_by".to_string(), a.ada_id.clone()),
            ("file_kind".to_string(), "team".to_string())
        ]
    );
    let members: Vec<(String, Option<String>, String)> = conn
        .prepare("SELECT name, email, password_hash FROM members ORDER BY created_at, id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let names: Vec<&str> = members.iter().map(|m| m.0.as_str()).collect();
    assert_eq!(names, ["Ada Admin", "bo", "di"], "Guests are not in it");
    assert!(members.iter().all(|m| m.1.is_none() && m.2.is_empty()));
    for table in ["sessions", "invites", "access_tokens", "ai_settings"] {
        let n: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "{table}");
    }
    for (table, at_least) in [
        ("comments", 1),
        ("for_you", 1),
        ("todos", 1),
        ("branches", 2),
    ] {
        let n: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert!(n >= at_least, "{table}: {n}");
    }
    // Every value of every table, as SQLite reads it, too.
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    for table in tables {
        let mut stmt = conn.prepare(&format!("SELECT * FROM {table}")).unwrap();
        let n = stmt.column_count();
        let mut rows = stmt.query([]).unwrap();
        let mut cells = Vec::new();
        while let Some(r) = rows.next().unwrap() {
            for i in 0..n {
                if let rusqlite::types::ValueRef::Text(t) | rusqlite::types::ValueRef::Blob(t) =
                    r.get_ref(i).unwrap()
                {
                    cells.extend_from_slice(t);
                    cells.push(0);
                }
            }
        }
        for (what, needle) in &a.secrets {
            assert!(!contains(&cells, needle), "{what} is in {table}");
        }
    }
}

#[tokio::test]
async fn a_team_file_comes_into_another_team_with_names_that_invites_claim() {
    let dir = tempfile::tempdir().unwrap();
    let a = team_a(dir.path()).await;
    let a_history = history(&a.app, &a.ada).await;
    let a_main = main_id(&a.app, &a.ada).await;
    let file = download(&a.app, &a.ada).await;

    let b = team(dir.path(), "b", |_| {});
    let cy = admin_as(&b, "cy@example.org", "Cy").await;
    let cy_id = me(&b, &cy).await;
    let b_main = main_id(&b, &cy).await;
    let (status, body) = upload(&b, &cy, file).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["you_were"], "Ada Admin");
    assert_eq!(
        body["members"],
        json!([
            { "id": cy_id, "name": "Cy", "claimed": true },
            { "id": a.bo_id, "name": "bo", "claimed": false },
            { "id": a.di_id, "name": "di", "claimed": false },
        ])
    );
    // Ada's work is Cy's now; Bo's stays Bo's.
    let b_history = history(&b, &cy).await;
    assert_eq!(
        b_history,
        a_history
            .replace(&a.ada_id, &cy_id)
            .replace(&a_main, &b_main)
    );
    assert!(b_history.contains(&a.bo_id));

    // The Members list: unclaimed Members have no email, even for an Admin.
    let members = b.get("/api/members", Some(&cy)).await.body;
    let bo = members["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == a.bo_id)
        .unwrap()
        .clone();
    assert_eq!(bo["claimed"], false);
    assert_eq!(bo["role"], "member");
    assert!(bo.get("email").is_none());
    // Nobody signs in as them.
    assert_eq!(b.login("", PASSWORD).await.status, StatusCode::UNAUTHORIZED);

    // An invite that claims a claimed Member, an unknown one or a non-uuid is refused.
    for claims in [json!(cy_id), json!(new_id()), json!("nope")] {
        let res = b
            .post(
                "/api/invites",
                Some(&cy),
                json!({ "email": "x@example.org", "role": "member", "claims": claims }),
            )
            .await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{claims}");
    }
    // An unclaimed Member can be removed like any other.
    let res = b
        .delete(&format!("/api/members/{}", a.di_id), Some(&cy))
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);

    // Bo is invited to take over his name.
    let res = b
        .post(
            "/api/invites",
            Some(&cy),
            json!({ "email": "bo@new.example.org", "role": "member", "claims": a.bo_id }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body["invite"]["claims"], a.bo_id);
    let token = res.body["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_string();
    let listed = b.get("/api/invites", Some(&cy)).await.body;
    assert_eq!(listed["invites"][0]["claims"], a.bo_id);
    let lookup = b
        .get(&format!("/api/invites/lookup?token={token}"), None)
        .await
        .body;
    assert_eq!(lookup["claims"], json!({ "id": a.bo_id, "name": "bo" }));
    let res = b
        .post(
            "/api/auth/accept-invite",
            None,
            json!({ "token": token, "name": "Bo Again", "password": PASSWORD }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let bo = res.cookie();
    assert_eq!(res.body["member"]["id"], a.bo_id);
    assert_eq!(res.body["member"]["claimed"], true);
    assert_eq!(res.body["member"]["email"], "bo@new.example.org");
    // Bo's earlier Changes, To-do and Comment read as his.
    let main = main_id(&b, &bo).await;
    let changes = b
        .get(&format!("/api/branches/{main}/changes"), Some(&bo))
        .await
        .body;
    assert!(
        changes["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["author"] == a.bo_id)
    );
    let todos = b.get("/api/todos", Some(&bo)).await.body;
    assert_eq!(todos["todos"][0]["owner"], a.bo_id);
    assert_eq!(todos["todos"][0]["created_by"], cy_id);
    let counts = b.get("/api/comments/counts", Some(&bo)).await.body;
    let card = counts.as_object().unwrap().keys().next().unwrap().clone();
    let thread = b
        .get(&format!("/api/cards/{card}/comments"), Some(&bo))
        .await
        .body;
    assert_eq!(thread["comments"][0]["author"], a.bo_id);
    assert_eq!(thread["comments"][0]["mentions"], json!([cy_id]));
    // The mention of Ada is in Cy's For you list now.
    let for_you = b.get("/api/for-you", Some(&cy)).await.body;
    assert_eq!(for_you["items"][0]["author"], a.bo_id);
    // A claim works once.
    let res = b
        .post(
            "/api/auth/accept-invite",
            None,
            json!({ "token": token, "name": "Bo", "password": PASSWORD }),
        )
        .await;
    assert_eq!(res.status, StatusCode::GONE);
    assert_eq!(
        b.login("bo@new.example.org", PASSWORD).await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn a_team_file_opens_as_a_local_workspace_whose_member_is_who_exported_it() {
    let dir = tempfile::tempdir().unwrap();
    let a = team_a(dir.path()).await;
    let a_history = history(&a.app, &a.ada).await;
    let file = dir.path().join("team.infall");
    std::fs::write(&file, download(&a.app, &a.ada).await).unwrap();

    let db = dir.path().join("laptop").join("workspace.db");
    let imported = import_workspace(&file, &db).unwrap();
    assert_eq!(
        imported,
        infall_server::local::Imported {
            preset: Some(Preset::Blank),
            from_team: true
        }
    );
    let w = local_ws(&db, Preset::Tutorial, "Laptop User", false);
    let c = w.enter().await;
    let me_now = w.app.get("/api/me", Some(&c)).await.body;
    assert_eq!(me_now["member"]["id"], a.ada_id);
    assert_eq!(me_now["member"]["name"], "Laptop User");
    assert_eq!(me_now["member"]["role"], "admin");
    // History is the same, but for the name; others are names only.
    assert_eq!(history(&w.app, &c).await, a_history);
    let members = w.app.get("/api/members", Some(&c)).await.body;
    let claimed: Vec<(Value, Value)> = members["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| (m["name"].clone(), m["claimed"].clone()))
        .collect();
    assert_eq!(
        claimed,
        [
            (json!("Laptop User"), json!(true)),
            (json!("bo"), json!(false)),
            (json!("di"), json!(false)),
        ]
    );
    // Bo's open To-do keeps its owner; the Comment is there; the Preset is Blank.
    let todos = w.app.get("/api/todos", Some(&c)).await.body;
    assert_eq!(todos["todos"][0]["owner"], a.bo_id);
    assert_eq!(
        w.app.get("/api/workspace", Some(&c)).await.body["preset"],
        "blank"
    );
    let counts = w.app.get("/api/comments/counts", Some(&c)).await.body;
    assert_eq!(counts.as_object().unwrap().len(), 1);
    // The name is given once: a later start keeps a changed one.
    let res = w
        .app
        .write(
            Method::PATCH,
            "/api/local/member",
            Some(&c),
            json!({ "name": "Renamed" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    drop(w);
    let w = local_ws(&db, Preset::Tutorial, "Laptop User", false);
    let c = w.enter().await;
    assert_eq!(
        w.app.get("/api/me", Some(&c)).await.body["member"]["name"],
        "Renamed"
    );
    // And a Local file of it goes back onto a Team server with the names still unclaimed.
    let back = dir.path().join("back.infall");
    drop(w);
    export_workspace(&db, &back).unwrap();
    let t = team(dir.path(), "t", |_| {});
    let zed = admin_as(&t, "zed@example.org", "Zed").await;
    let (status, body) = upload(&t, &zed, std::fs::read(&back).unwrap()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["you_were"], "Renamed");
    assert_eq!(body["members"].as_array().unwrap().len(), 3);
    assert_eq!(body["members"][1]["claimed"], false);
}

/// Decision 6: in a Local Workspace from a Team file, the other Members are names only and
/// their To-dos keep them as owner; the Local Member may tick, change and delete them (the
/// name stays on them). On a Team server a name's To-dos wait for whoever claims the name.
#[tokio::test]
async fn the_to_dos_of_names_only_are_the_local_members_to_finish() {
    let dir = tempfile::tempdir().unwrap();
    let a = team_a(dir.path()).await;
    // Bo's own To-do, and one Bo gave Di: neither was Ada's.
    let mut ids = Vec::new();
    for (owner, text) in [(&a.bo_id, "Bo's own"), (&a.di_id, "For Di, from Bo")] {
        let res = a
            .app
            .post(
                "/api/todos",
                Some(&a.bo),
                json!({ "owner": owner, "text": text }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        ids.push(res.body["todo"]["id"].as_str().unwrap().to_string());
    }
    let file_bytes = download(&a.app, &a.ada).await;

    // On another Team server the names are still to be claimed: nobody ticks for them.
    let b = team(dir.path(), "b", |_| {});
    let cy = admin_as(&b, "cy@example.org", "Cy").await;
    let (status, body) = upload(&b, &cy, file_bytes.clone()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    for id in &ids {
        let path = format!("/api/todos/{id}");
        let res = b
            .write(Method::PATCH, &path, Some(&cy), json!({ "done": true }))
            .await;
        assert_eq!(res.status, StatusCode::FORBIDDEN, "{}", res.text);
        assert_eq!(
            b.delete(&path, Some(&cy)).await.status,
            StatusCode::FORBIDDEN
        );
    }

    // In a Local Workspace they are the Local Member's to finish.
    let file = dir.path().join("team.infall");
    std::fs::write(&file, &file_bytes).unwrap();
    let db = dir.path().join("laptop").join("workspace.db");
    import_workspace(&file, &db).unwrap();
    let w = local_ws(&db, Preset::Blank, "Laptop User", false);
    let c = w.enter().await;
    for id in &ids {
        let path = format!("/api/todos/{id}");
        let res = w
            .app
            .write(
                Method::PATCH,
                &path,
                Some(&c),
                json!({ "done": true, "text": "Finished here" }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        assert_eq!(res.body["todo"]["done"], true);
        assert_eq!(res.body["todo"]["text"], "Finished here");
    }
    let todos = w.app.get("/api/todos", Some(&c)).await.body;
    let by_id = |id: &str| -> Value {
        todos["todos"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == id)
            .unwrap()
            .clone()
    };
    // Nothing was reassigned: the names are still on them, and who added them.
    assert_eq!(by_id(&ids[0])["owner"], a.bo_id);
    assert_eq!(by_id(&ids[1])["owner"], a.di_id);
    assert_eq!(by_id(&ids[1])["created_by"], a.bo_id);
    let path = format!("/api/todos/{}", ids[1]);
    let res = w
        .app
        .write(Method::PATCH, &path, Some(&c), json!({ "done": false }))
        .await;
    assert_eq!(res.body["todo"]["done"], false);
    assert_eq!(w.app.delete(&path, Some(&c)).await.status, StatusCode::OK);
    // A To-do of the Local Member's own is theirs as always.
    let res = w
        .app
        .post(
            "/api/todos",
            Some(&c),
            json!({ "owner": a.ada_id, "text": "Mine" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
}

// ---------------------------------------------------------------- the moved Workspace

#[tokio::test]
async fn a_moved_local_workspace_reads_but_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("ws.db");
    // Made and used, then moved.
    let card;
    let comment;
    let todo;
    {
        let w = local_ws(&db, Preset::Tutorial, "Ada", false);
        let c = w.enter().await;
        let main = main_id(&w.app, &c).await;
        card = new_id();
        w.app
            .ops(&c, &main, json!([create_card(&card, "Before")]))
            .await;
        comment = w
            .app
            .post(
                &format!("/api/cards/{card}/comments"),
                Some(&c),
                json!({ "text": "x" }),
            )
            .await
            .body["id"]
            .as_str()
            .unwrap()
            .to_string();
        todo = w.app.get("/api/todos", Some(&c)).await.body["todos"][0]["id"]
            .as_str()
            .unwrap()
            .to_string();
    }
    let w = local_ws(&db, Preset::Tutorial, "Ada", true);
    let c = w.enter().await;
    let me_id = me(&w.app, &c).await;
    let main = main_id(&w.app, &c).await;
    let before = history(&w.app, &c).await;
    assert_eq!(
        w.app.get("/api/workspace", Some(&c)).await.body,
        json!({
            "kind": "local", "preset": "tutorial", "empty": false, "read_only": true,
            "moved_to": "https://team.example.org",
        })
    );
    let seq = w.app.get("/api/branches", Some(&c)).await.body["branches"][0]["seq"].clone();
    let writes: Vec<(Method, String, Value)> = vec![
        (
            Method::POST,
            format!("/api/branches/{main}/ops"),
            json!({ "ops": [create_card(&new_id(), "x")] }),
        ),
        (
            Method::POST,
            format!("/api/branches/{main}/checkpoints"),
            json!({ "name": "c" }),
        ),
        (
            Method::POST,
            format!("/api/branches/{main}/restore"),
            json!({ "to_seq": 0 }),
        ),
        (
            Method::POST,
            "/api/branches".into(),
            json!({ "name": "b", "from": { "branch": main, "seq": seq } }),
        ),
        (Method::POST, "/api/merges".into(), json!({})),
        (
            Method::POST,
            "/api/todos".into(),
            json!({ "owner": me_id, "text": "t" }),
        ),
        (
            Method::PATCH,
            format!("/api/todos/{todo}"),
            json!({ "done": true }),
        ),
        (Method::DELETE, format!("/api/todos/{todo}"), Value::Null),
        (
            Method::POST,
            format!("/api/cards/{card}/comments"),
            json!({ "text": "y" }),
        ),
        (
            Method::PATCH,
            format!("/api/comments/{comment}"),
            json!({ "text": "z" }),
        ),
        (
            Method::DELETE,
            format!("/api/comments/{comment}"),
            Value::Null,
        ),
        (
            Method::PUT,
            format!("/api/cards/{card}/comments/resolved"),
            json!({ "resolved": true }),
        ),
        (
            Method::POST,
            "/api/for-you/seen".into(),
            json!({ "up_to": comment }),
        ),
        (Method::POST, "/api/tokens".into(), json!({ "name": "t" })),
        (
            Method::PUT,
            "/api/ai/key".into(),
            json!({ "key": "sk-or-v1-0123456789abcdefghij" }),
        ),
        (
            Method::PUT,
            "/api/ai/model".into(),
            json!({ "model": "a/b" }),
        ),
        (Method::DELETE, "/api/ai/key".into(), Value::Null),
        (
            Method::POST,
            "/api/ai/chat".into(),
            json!({ "messages": [{ "role": "user", "content": "hi" }] }),
        ),
        (
            Method::PATCH,
            "/api/local/member".into(),
            json!({ "name": "New" }),
        ),
        (
            Method::PUT,
            "/api/local/tutorial".into(),
            json!({ "state": 1 }),
        ),
        (
            Method::POST,
            format!("/api/suggestions/{}/reject", new_id()),
            Value::Null,
        ),
        (Method::POST, "/api/workspace/import".into(), Value::Null),
        (Method::POST, "/api/auth/logout".into(), Value::Null),
    ];
    for (method, path, body) in writes {
        let res = w.app.write(method.clone(), &path, Some(&c), body).await;
        assert_eq!(
            res.status,
            StatusCode::FORBIDDEN,
            "{method} {path}: {}",
            res.text
        );
        assert_eq!(res.code(), "moved", "{method} {path}");
        assert_eq!(
            res.body["error"]["message"],
            "This Workspace was moved to a Team server; open it there to make changes."
        );
    }
    // Nothing changed; reading, search, History and lookups still work.
    assert_eq!(history(&w.app, &c).await, before);
    for path in [
        "/api/todos".to_string(),
        format!("/api/cards/{card}/comments"),
        "/api/comments/counts".into(),
        "/api/for-you".into(),
        "/api/members".into(),
        "/api/me".into(),
        format!("/api/branches/{main}/board?at=1"),
        "/api/local/tutorial".into(),
        "/api/tokens".into(),
    ] {
        let res = w.app.get(&path, Some(&c)).await;
        assert_eq!(res.status, StatusCode::OK, "{path}: {}", res.text);
    }
    // A Source lookup only reads (and this one is refused before anything is sent).
    let res = w.app.post("/api/sources/lookup", Some(&c), json!({})).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    // Exporting it still works.
    drop(w);
    export_workspace(&db, &dir.path().join("out.infall")).unwrap();
}

#[tokio::test]
async fn the_live_connection_of_a_moved_workspace_takes_no_claim() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::http::HeaderValue;
    let dir = tempfile::tempdir().unwrap();
    let web = web_dir();
    let db = dir.path().join("ws.db");
    let options = |read_only| LocalOptions {
        db: db.clone(),
        web_dir: web.path().to_path_buf(),
        preset: Preset::Blank,
        member_name: "Ada".into(),
        port: None,
        read_only,
        moved_to: None,
    };
    start_local(options(false)).await.unwrap().stop().await;
    let server = start_local(options(true)).await.unwrap();
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
    let branches: Value = http
        .get(format!("{}/api/branches", server.origin()))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let main = branches["branches"][0]["id"].as_str().unwrap().to_string();
    let ws_url = server.origin().replace("http://", "ws://") + "/api/ws";
    let mut req = ws_url.into_client_request().unwrap();
    req.headers_mut()
        .insert("cookie", HeaderValue::from_str(&cookie).unwrap());
    req.headers_mut()
        .insert("origin", HeaderValue::from_str(server.origin()).unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    ws.send(Message::Text(
        json!({ "type": "subscribe", "branch": main, "after": 0 })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let mut frames = Vec::new();
    ws.send(Message::Text(
        json!({ "type": "editing", "card": new_id() })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    while frames.len() < 4 {
        let msg = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        if let Message::Text(t) = msg {
            let v: Value = serde_json::from_str(&t).unwrap();
            let done = v["type"] == "error";
            frames.push(v);
            if done {
                break;
            }
        }
    }
    let last = frames.last().unwrap();
    assert_eq!(last["type"], "error", "{frames:?}");
    assert_eq!(last["code"], "moved");
    assert_eq!(
        last["message"],
        "This Workspace was moved to a Team server; open it there to make changes."
    );
    server.stop().await;
}

// ---------------------------------------------------------------- live: the Board changed

#[tokio::test]
async fn everyone_connected_catches_up_after_an_import() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::http::HeaderValue;
    let dir = tempfile::tempdir().unwrap();
    let (file, ..) = used_local_file(dir.path()).await;
    let app = team(dir.path(), "team", |_| {});
    let admin = app.admin().await;
    let bo = app.join(&admin, "bo@example.org", "member", None).await;
    let main = main_id(&app, &admin).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = app.router.clone();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let mut req = format!("ws://{addr}/api/ws").into_client_request().unwrap();
    req.headers_mut()
        .insert("cookie", HeaderValue::from_str(&bo).unwrap());
    req.headers_mut()
        .insert("origin", HeaderValue::from_static(ORIGIN));
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    ws.send(Message::Text(
        json!({ "type": "subscribe", "branch": main, "after": 0 })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let next = async |ws: &mut tokio_tungstenite::WebSocketStream<_>| loop {
        let msg = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        if let Message::Text(t) = msg {
            return serde_json::from_str::<Value>(&t).unwrap();
        }
    };
    // subscribed, presence, editing.
    for kind in ["subscribed", "presence", "editing"] {
        assert_eq!(next(&mut ws).await["type"], kind);
    }
    let (status, _) = upload(&app, &admin, std::fs::read(&file).unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    // The catch-up of missed frames: the Branch list, then everything on `main`.
    let branches = next(&mut ws).await;
    assert_eq!(branches["type"], "branches");
    assert!(branches.to_string().contains("longer-walks"));
    let changes = next(&mut ws).await;
    assert_eq!(changes["type"], "changes");
    assert_eq!(changes["branch"], main);
    let head = app.get("/api/branches", Some(&bo)).await.body["branches"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["name"] == "main")
        .unwrap()["seq"]
        .clone();
    assert_eq!(changes["seq"], head);
    assert_eq!(
        changes["changes"].as_array().unwrap().len() as u64,
        head.as_u64().unwrap()
    );
}

// ---------------------------------------------------------------- the command line

const BIN: &str = env!("CARGO_BIN_EXE_infall-server");

fn cli(db: &Path, args: &[&str]) -> std::process::Output {
    std::process::Command::new(BIN)
        .args(args)
        .env("INFALL_DB", db)
        .env("INFALL_ADMIN_PASSWORD", PASSWORD)
        .env("RUST_LOG", "warn")
        .output()
        .unwrap()
}

fn ok(out: std::process::Output) -> String {
    assert!(
        out.status.success(),
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).to_string()
}

/// A `infall-server serve` process on `db`; killed when dropped.
struct Served {
    child: std::process::Child,
    origin: String,
}

impl Drop for Served {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[allow(clippy::zombie_processes)] // waited for in `Served`'s drop
async fn serve(db: &Path, web: &Path) -> Served {
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let origin = format!("http://127.0.0.1:{port}");
    let child = std::process::Command::new(BIN)
        .arg("serve")
        .env("INFALL_DB", db)
        .env("INFALL_ADDR", format!("127.0.0.1:{port}"))
        .env("INFALL_PUBLIC_ORIGIN", &origin)
        .env("INFALL_WEB_DIR", web)
        .env("RUST_LOG", "warn")
        .spawn()
        .unwrap();
    // Dropping `Served` kills and waits for the process, whatever happens next.
    let served = Served { child, origin };
    for _ in 0..200 {
        if reqwest::get(format!("{}/api/health", served.origin))
            .await
            .is_ok()
        {
            return served;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("the server did not start");
}

struct Http {
    http: reqwest::Client,
    origin: String,
    cookie: String,
}

impl Http {
    async fn login(origin: &str, email: &str) -> Http {
        let http = reqwest::Client::new();
        let res = http
            .post(format!("{origin}/api/auth/login"))
            .header("origin", origin)
            .header("x-infall-request", "1")
            .json(&json!({ "email": email, "password": PASSWORD }))
            .send()
            .await
            .unwrap();
        assert!(res.status().is_success());
        let cookie = res.headers()[reqwest::header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string();
        Http {
            http,
            origin: origin.to_string(),
            cookie,
        }
    }

    async fn get(&self, path: &str) -> Value {
        self.http
            .get(format!("{}{path}", self.origin))
            .header("cookie", &self.cookie)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap()
    }

    async fn post(&self, path: &str, body: Value) -> reqwest::StatusCode {
        self.http
            .post(format!("{}{path}", self.origin))
            .header("cookie", &self.cookie)
            .header("origin", &self.origin)
            .header("x-infall-request", "1")
            .json(&body)
            .send()
            .await
            .unwrap()
            .status()
    }

    async fn main(&self) -> String {
        self.get("/api/branches").await["branches"]
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

#[tokio::test]
async fn export_workspace_on_the_command_line_while_the_server_runs() {
    let dir = tempfile::tempdir().unwrap();
    let web = web_dir();
    let db = dir.path().join("server.db");
    ok(cli(
        &db,
        &[
            "create-admin",
            "--email",
            "ada@example.org",
            "--name",
            "Ada",
        ],
    ));
    let served = serve(&db, web.path()).await;
    let c = Http::login(&served.origin, "ada@example.org").await;
    let main = c.main().await;
    for i in 0..20 {
        let status = c
            .post(
                &format!("/api/branches/{main}/ops"),
                json!({ "ops": [create_card(&new_id(), &format!("Card {i}"))] }),
            )
            .await;
        assert!(status.is_success());
    }
    // The newest Changes are in the -wal of the running server; the export has them all.
    let dest = dir.path().join("backup.infall");
    let out = ok(cli(&db, &["export-workspace", dest.to_str().unwrap()]));
    assert!(out.contains("backup.infall"), "{out}");
    let conn = rusqlite::Connection::open(&dest).unwrap();
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM changes", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 20);
    let kind: String = conn
        .query_row(
            "SELECT value FROM settings WHERE name = 'file_kind'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(kind, "team");
    let email: Option<String> = conn
        .query_row("SELECT email FROM members", [], |r| r.get(0))
        .unwrap();
    assert_eq!(email, None);
    drop(conn);
    assert!(!contains(
        &std::fs::read(&dest).unwrap(),
        b"ada@example.org"
    ));
    // The server goes on as before.
    let status = c
        .post(
            &format!("/api/branches/{main}/ops"),
            json!({ "ops": [create_card(&new_id(), "After")] }),
        )
        .await;
    assert!(status.is_success());
    // Not over an existing file.
    let out = cli(&db, &["export-workspace", dest.to_str().unwrap()]);
    assert!(!out.status.success());
    drop(served);
}

#[tokio::test]
async fn import_workspace_on_the_command_line() {
    let dir = tempfile::tempdir().unwrap();
    let web = web_dir();
    let (file, local_history, local_member, local_main) = used_local_file(dir.path()).await;
    let file = file.to_str().unwrap();
    let db = dir.path().join("server.db");
    ok(cli(
        &db,
        &[
            "create-admin",
            "--email",
            "ada@example.org",
            "--name",
            "Ada",
        ],
    ));
    // Only an Admin that exists.
    let out = cli(
        &db,
        &[
            "import-workspace",
            file,
            "--admin-email",
            "nobody@example.org",
        ],
    );
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("no Admin"));
    let out = ok(cli(
        &db,
        &["import-workspace", file, "--admin-email", "ADA@example.org"],
    ));
    assert!(out.contains("Ada Lovelace"), "{out}");
    // Not twice.
    let out = cli(
        &db,
        &["import-workspace", file, "--admin-email", "ada@example.org"],
    );
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("not empty"));
    // Not a Workspace file.
    let other = dir.path().join("other.db");
    ok(cli(
        &other,
        &["create-admin", "--email", "x@example.org", "--name", "X"],
    ));
    let junk = dir.path().join("junk.infall");
    std::fs::write(&junk, b"not sqlite").unwrap();
    let out = cli(
        &other,
        &[
            "import-workspace",
            junk.to_str().unwrap(),
            "--admin-email",
            "x@example.org",
        ],
    );
    assert!(!out.status.success());

    // The server opens it with the History as it was, under Ada's name.
    let served = serve(&db, web.path()).await;
    let c = Http::login(&served.origin, "ada@example.org").await;
    let ada = c.get("/api/me").await["member"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let main = c.main().await;
    let changes = c.get(&format!("/api/branches/{main}/changes")).await;
    let local_changes: Value = serde_json::from_str(&local_history).unwrap();
    assert_eq!(
        changes.to_string(),
        local_changes["main"]["changes"]
            .to_string()
            .replace(&local_member, &ada)
            .replace(&local_main, &main)
    );
    drop(served);
}

#[tokio::test]
async fn a_server_running_while_the_command_line_imports_refuses_to_write_until_restarted() {
    let dir = tempfile::tempdir().unwrap();
    let web = web_dir();
    let (file, ..) = used_local_file(dir.path()).await;
    let db = dir.path().join("server.db");
    ok(cli(
        &db,
        &[
            "create-admin",
            "--email",
            "ada@example.org",
            "--name",
            "Ada",
        ],
    ));
    let served = serve(&db, web.path()).await;
    let c = Http::login(&served.origin, "ada@example.org").await;
    let main = c.main().await;
    ok(cli(
        &db,
        &[
            "import-workspace",
            file.to_str().unwrap(),
            "--admin-email",
            "ada@example.org",
        ],
    ));
    // The running server still holds the empty Workspace; writing it would lose the import.
    let status = c
        .post(
            &format!("/api/branches/{main}/ops"),
            json!({ "ops": [create_card(&new_id(), "Lost?")] }),
        )
        .await;
    assert_eq!(status, reqwest::StatusCode::INTERNAL_SERVER_ERROR);
    drop(served);
    let served = serve(&db, web.path()).await;
    let c = Http::login(&served.origin, "ada@example.org").await;
    let branches = c.get("/api/branches").await.to_string();
    assert!(branches.contains("longer-walks"));
    let status = c
        .post(
            &format!("/api/branches/{}/ops", c.main().await),
            json!({ "ops": [create_card(&new_id(), "Kept")] }),
        )
        .await;
    assert!(status.is_success());
    drop(served);
}
