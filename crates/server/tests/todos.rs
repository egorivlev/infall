mod common;

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use common::*;
use qoop_server::store::{MemoryStore, SCHEMA_VERSION, SqliteStore, Store};
use serde_json::{Value, json};

/// An Admin, two Members and a Guest.
struct World {
    app: TestApp,
    admin: String,
    bea: String,
    cal: String,
    guest: String,
    admin_id: String,
    bea_id: String,
    cal_id: String,
    guest_id: String,
}

async fn member_id(app: &TestApp, cookie: &str) -> String {
    app.get("/api/me", Some(cookie)).await.body["member"]["id"]
        .as_str()
        .unwrap()
        .to_string()
}

async fn world_on(store: Arc<dyn Store>) -> World {
    let app = TestApp::with_store(store);
    let admin = app.admin().await;
    let bea = app.join(&admin, "bea@example.org", "member", None).await;
    let cal = app.join(&admin, "cal@example.org", "member", None).await;
    let guest = app
        .join(&admin, "gus@example.org", "guest", Some(START + 1_000_000))
        .await;
    World {
        admin_id: member_id(&app, &admin).await,
        bea_id: member_id(&app, &bea).await,
        cal_id: member_id(&app, &cal).await,
        guest_id: member_id(&app, &guest).await,
        app,
        admin,
        bea,
        cal,
        guest,
    }
}

async fn world() -> World {
    world_on(Arc::new(MemoryStore::new())).await
}

fn stores() -> Vec<Arc<dyn Store>> {
    vec![
        Arc::new(MemoryStore::new()),
        Arc::new(SqliteStore::open_in_memory().unwrap()),
    ]
}

impl World {
    /// Adds a To-do and returns it.
    async fn add(&self, cookie: &str, owner: &str, text: &str) -> Value {
        let res = self
            .app
            .post(
                "/api/todos",
                Some(cookie),
                json!({ "owner": owner, "text": text }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        res.body["todo"].clone()
    }

    async fn patch(&self, cookie: &str, id: &str, body: Value) -> Res {
        self.app
            .write(
                Method::PATCH,
                &format!("/api/todos/{id}"),
                Some(cookie),
                body,
            )
            .await
    }

    async fn remove(&self, cookie: &str, id: &str) -> Res {
        self.app
            .delete(&format!("/api/todos/{id}"), Some(cookie))
            .await
    }

    async fn list(&self, cookie: &str) -> Vec<Value> {
        let res = self.app.get("/api/todos", Some(cookie)).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        res.body["todos"].as_array().unwrap().clone()
    }
}

fn id_of(todo: &Value) -> String {
    todo["id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn a_todo_is_added_listed_changed_and_deleted() {
    for store in stores() {
        let w = world_on(store).await;
        assert!(w.list(&w.admin).await.is_empty());

        let card = json!({ "id": new_id(), "title": "Spin glasses", "branch": new_id() });
        let res = w
            .app
            .post(
                "/api/todos",
                Some(&w.admin),
                json!({ "owner": w.admin_id, "text": "  Read the review  ", "card": card }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        let todo = res.body["todo"].clone();
        let id = id_of(&todo);
        assert_eq!(
            todo,
            json!({
                "id": id,
                "owner": w.admin_id,
                "text": "Read the review",
                "done": false,
                "created_by": w.admin_id,
                "created_at": START,
                "card": card,
            })
        );
        // Everyone but Guests sees the same list.
        assert_eq!(w.list(&w.admin).await, vec![todo.clone()]);
        assert_eq!(w.list(&w.bea).await, vec![todo.clone()]);

        w.app.clock.advance(5_000);
        let res = w
            .patch(&w.admin, &id, json!({ "text": " Read it twice " }))
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        assert_eq!(res.body["todo"]["text"], "Read it twice");
        assert_eq!(res.body["todo"]["card"], card, "untouched fields stay");

        let res = w.patch(&w.admin, &id, json!({ "done": true })).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        assert_eq!(res.body["todo"]["done"], true);
        assert_eq!(res.body["todo"]["done_at"], START + 5_000);
        // Ticking again does not move the time.
        w.app.clock.advance(5_000);
        let res = w.patch(&w.admin, &id, json!({ "done": true })).await;
        assert_eq!(res.body["todo"]["done_at"], START + 5_000);
        let res = w.patch(&w.admin, &id, json!({ "done": false })).await;
        assert_eq!(res.body["todo"]["done"], false);
        assert!(res.body["todo"].get("done_at").is_none());

        // `card: null` clears the pointer; a new one can be set; an empty patch changes nothing.
        let res = w.patch(&w.admin, &id, json!({ "card": null })).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        assert!(res.body["todo"].get("card").is_none());
        assert!(w.list(&w.admin).await[0].get("card").is_none());
        let other = json!({ "id": new_id(), "title": "", "branch": new_id() });
        let res = w.patch(&w.admin, &id, json!({ "card": other })).await;
        assert_eq!(res.body["todo"]["card"], other);
        let res = w.patch(&w.admin, &id, json!({})).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        assert_eq!(vec![res.body["todo"].clone()], w.list(&w.admin).await);
        assert_eq!(res.body["todo"]["text"], "Read it twice");
        assert_eq!(res.body["todo"]["created_at"], START);

        let res = w.remove(&w.admin, &id).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        assert_eq!(res.body, json!({}));
        assert!(w.list(&w.admin).await.is_empty());
        assert_eq!(w.remove(&w.admin, &id).await.status, StatusCode::NOT_FOUND);
    }
}

#[tokio::test]
async fn the_list_is_ordered_by_creation_time_then_id() {
    for store in stores() {
        let w = world_on(store).await;
        w.app.clock.advance(10);
        let late_a = w.add(&w.admin, &w.admin_id, "late a").await;
        let late_b = w.add(&w.bea, &w.bea_id, "late b").await;
        let mut late = vec![id_of(&late_a), id_of(&late_b)];
        late.sort();
        let ids: Vec<String> = w.list(&w.cal).await.iter().map(id_of).collect();
        assert_eq!(ids, late, "same time: by id");

        w.app.clock.advance(10);
        let last = w.add(&w.cal, &w.cal_id, "last").await;
        let ids: Vec<String> = w.list(&w.cal).await.iter().map(id_of).collect();
        assert_eq!(ids, [late.clone(), vec![id_of(&last)]].concat());
    }
}

#[tokio::test]
async fn only_the_owner_ticks_and_only_owner_or_creator_edits_or_deletes() {
    let w = world().await;
    // Bea assigns one to Cal.
    let todo = w.add(&w.bea, &w.cal_id, "Check the derivation").await;
    let id = id_of(&todo);
    assert_eq!(todo["owner"], w.cal_id.as_str());
    assert_eq!(todo["created_by"], w.bea_id.as_str());

    // The creator may change text and card, but not tick it.
    let res = w
        .patch(&w.bea, &id, json!({ "text": "Check it again" }))
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let card = json!({ "id": new_id(), "title": "T", "branch": new_id() });
    let res = w.patch(&w.bea, &id, json!({ "card": card })).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    for body in [
        json!({ "done": true }),
        json!({ "done": false }),
        json!({ "done": true, "text": "Sneaky" }),
    ] {
        let res = w.patch(&w.bea, &id, body).await;
        assert_eq!(res.status, StatusCode::FORBIDDEN);
        assert_eq!(res.code(), "forbidden");
    }
    let now = &w.list(&w.cal).await[0];
    assert_eq!(now["done"], false);
    assert_eq!(
        now["text"], "Check it again",
        "a refused patch changes nothing"
    );

    // A stranger, even an Admin, may do nothing to it.
    for body in [
        json!({ "text": "Mine now" }),
        json!({ "done": true }),
        json!({ "card": null }),
        json!({}),
    ] {
        let res = w.patch(&w.admin, &id, body).await;
        assert_eq!(res.status, StatusCode::FORBIDDEN);
        assert_eq!(res.code(), "forbidden");
    }
    let res = w.remove(&w.admin, &id).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.code(), "forbidden");
    assert_eq!(w.list(&w.cal).await.len(), 1);

    // The owner may do everything.
    let res = w
        .patch(
            &w.cal,
            &id,
            json!({ "done": true, "text": "Done it", "card": null }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body["todo"]["done"], true);
    assert_eq!(res.body["todo"]["text"], "Done it");
    assert!(res.body["todo"].get("card").is_none());

    // The creator may delete it; so may the owner.
    assert_eq!(w.remove(&w.bea, &id).await.status, StatusCode::OK);
    let second = id_of(&w.add(&w.bea, &w.cal_id, "Another").await);
    assert_eq!(w.remove(&w.cal, &second).await.status, StatusCode::OK);
    assert!(w.list(&w.cal).await.is_empty());
}

#[tokio::test]
async fn guests_and_the_signed_out_are_refused_everywhere() {
    let w = world().await;
    let id = id_of(&w.add(&w.bea, &w.bea_id, "Private to the team").await);
    let res = w.app.get("/api/todos", Some(&w.guest)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.code(), "forbidden");
    assert!(!res.text.contains("Private"));
    let res = w
        .app
        .post(
            "/api/todos",
            Some(&w.guest),
            json!({ "owner": w.bea_id, "text": "From a guest" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.code(), "forbidden");
    let res = w.patch(&w.guest, &id, json!({ "text": "Changed" })).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.code(), "forbidden");
    let res = w.remove(&w.guest, &id).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.code(), "forbidden");
    // A Guest learns nothing about which ids exist either.
    let res = w.remove(&w.guest, &new_id()).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);

    assert_eq!(
        w.app.get("/api/todos", None).await.status,
        StatusCode::UNAUTHORIZED
    );
    let res = w
        .app
        .post(
            "/api/todos",
            None,
            json!({ "owner": w.bea_id, "text": "x" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    let res = w
        .app
        .write(Method::PATCH, &format!("/api/todos/{id}"), None, json!({}))
        .await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    let res = w.app.delete(&format!("/api/todos/{id}"), None).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);

    let list = w.list(&w.bea).await;
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["text"], "Private to the team");
}

#[tokio::test]
async fn the_owner_must_be_an_existing_member_or_admin() {
    let w = world().await;
    for owner in [w.guest_id.clone(), new_id(), "not-an-id".to_string()] {
        let res = w
            .app
            .post(
                "/api/todos",
                Some(&w.bea),
                json!({ "owner": owner, "text": "For nobody" }),
            )
            .await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{owner}");
        assert_eq!(res.code(), "bad_request");
    }
    assert!(w.list(&w.bea).await.is_empty());
    // An Admin and a Member are both fine.
    w.add(&w.bea, &w.admin_id, "For the Admin").await;
    w.add(&w.admin, &w.bea_id, "For a Member").await;
    assert_eq!(w.list(&w.bea).await.len(), 2);
}

#[tokio::test]
async fn text_and_card_are_validated() {
    let w = world().await;
    let ok_card = || json!({ "id": new_id(), "title": "T", "branch": new_id() });
    let bad_bodies = [
        json!({ "owner": w.bea_id, "text": "" }),
        json!({ "owner": w.bea_id, "text": "   " }),
        json!({ "owner": w.bea_id, "text": "x".repeat(501) }),
        json!({ "owner": w.bea_id, "text": "two\nlines" }),
        json!({ "owner": w.bea_id, "text": "bell\u{7}" }),
        json!({ "owner": w.bea_id }),
        json!({ "text": "no owner" }),
        json!({ "owner": w.bea_id, "text": 5 }),
        json!({ "owner": w.bea_id, "text": "x", "card": { "id": "nope", "title": "T", "branch": new_id() } }),
        json!({ "owner": w.bea_id, "text": "x", "card": { "id": new_id(), "title": "T", "branch": "main" } }),
        json!({ "owner": w.bea_id, "text": "x", "card": { "id": new_id(), "title": "T" } }),
        json!({ "owner": w.bea_id, "text": "x", "card": { "id": new_id(), "branch": new_id() } }),
        json!({ "owner": w.bea_id, "text": "x", "card": { "id": new_id(), "title": "t".repeat(301), "branch": new_id() } }),
        json!({ "owner": w.bea_id, "text": "x", "card": "a card" }),
    ];
    for body in bad_bodies {
        let res = w.app.post("/api/todos", Some(&w.bea), body.clone()).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(res.code(), "bad_request", "{body}");
    }
    assert!(w.list(&w.bea).await.is_empty());

    // The limits are in characters, counted after trimming.
    let text = "é".repeat(500);
    let title = "й".repeat(300);
    let card = json!({ "id": new_id(), "title": title, "branch": new_id() });
    let res = w
        .app
        .post(
            "/api/todos",
            Some(&w.bea),
            json!({ "owner": w.bea_id, "text": format!("  {text}  "), "card": card }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body["todo"]["text"], text.as_str());
    assert_eq!(res.body["todo"]["card"], card);
    let id = id_of(&res.body["todo"]);

    let bad_patches = [
        json!({ "text": "" }),
        json!({ "text": " \t " }),
        json!({ "text": "x".repeat(501) }),
        json!({ "text": "a\u{0}b" }),
        json!({ "text": null, "done": "yes" }),
        json!({ "done": 1 }),
        json!({ "card": { "id": "nope", "title": "T", "branch": new_id() } }),
        json!({ "card": { "id": new_id(), "title": "t".repeat(301), "branch": new_id() } }),
        // One bad field refuses the whole patch.
        json!({ "text": "Fine", "done": true, "card": { "id": new_id(), "title": "t".repeat(301), "branch": new_id() } }),
    ];
    for body in bad_patches {
        let res = w.patch(&w.bea, &id, body.clone()).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(res.code(), "bad_request", "{body}");
    }
    let now = &w.list(&w.bea).await[0];
    assert_eq!(now["text"], text.as_str());
    assert_eq!(now["done"], false);
    assert_eq!(now["card"], card);
    let res = w.patch(&w.bea, &id, json!({ "card": ok_card() })).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
}

#[tokio::test]
async fn an_unknown_id_is_not_found() {
    let w = world().await;
    for id in [new_id(), "nope".to_string()] {
        let res = w.patch(&w.bea, &id, json!({ "text": "x" })).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "{id}");
        assert_eq!(res.code(), "not_found");
        let res = w.remove(&w.bea, &id).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "{id}");
        assert_eq!(res.code(), "not_found");
    }
}

#[tokio::test]
async fn removing_a_member_deletes_their_own_todos_and_keeps_what_they_assigned() {
    for store in stores() {
        let w = world_on(store).await;
        let own = id_of(&w.add(&w.bea, &w.bea_id, "Bea's own").await);
        let from_cal = id_of(&w.add(&w.cal, &w.bea_id, "Cal gave Bea this").await);
        let assigned = id_of(&w.add(&w.bea, &w.cal_id, "Bea gave Cal this").await);
        let unrelated = id_of(&w.add(&w.admin, &w.admin_id, "The Admin's").await);

        let res = w
            .app
            .delete(&format!("/api/members/{}", w.bea_id), Some(&w.admin))
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);

        let left = w.list(&w.admin).await;
        let ids: Vec<String> = left.iter().map(id_of).collect();
        assert!(!ids.contains(&own));
        assert!(!ids.contains(&from_cal));
        assert!(ids.contains(&assigned));
        assert!(ids.contains(&unrelated));
        assert_eq!(left.len(), 2);
        // The kept one still names who added it, and its owner can still use it.
        let kept = left.iter().find(|t| id_of(t) == assigned).unwrap();
        assert_eq!(kept["created_by"], w.bea_id.as_str());
        let res = w.patch(&w.cal, &assigned, json!({ "done": true })).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        // A removed Member can no longer be given To-dos.
        let res = w
            .app
            .post(
                "/api/todos",
                Some(&w.admin),
                json!({ "owner": w.bea_id, "text": "Too late" }),
            )
            .await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST);
    }
}

#[tokio::test]
async fn todos_survive_a_restart_on_the_same_sqlite_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("qoop.db");
    let before = {
        let w = world_on(Arc::new(SqliteStore::open(&path).unwrap())).await;
        let card = json!({ "id": new_id(), "title": "Kept", "branch": new_id() });
        let res = w
            .app
            .post(
                "/api/todos",
                Some(&w.bea),
                json!({ "owner": w.cal_id, "text": "Outlives the process", "card": card }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        let plain = w.add(&w.cal, &w.cal_id, "No card").await;
        w.app.clock.advance(1_000);
        let res = w
            .patch(&w.cal, &id_of(&plain), json!({ "done": true }))
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        w.list(&w.bea).await
    };
    assert_eq!(before.len(), 2);
    let app = TestApp::with_store(Arc::new(SqliteStore::open(&path).unwrap()));
    let cookie = app.login("bea@example.org", PASSWORD).await.cookie();
    let after = app.get("/api/todos", Some(&cookie)).await;
    assert_eq!(after.body["todos"], Value::Array(before));
}

/// The schema a database file had before M4 (`user_version` 1).
const M3_SCHEMA: &str = "
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
PRAGMA user_version = 1;
";

#[tokio::test]
async fn a_database_file_from_before_m4_upgrades_in_place_and_keeps_its_data() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("qoop.db");

    // An M3 file with an account and a Board holding one Card.
    let scratch = MemoryStore::new();
    let ada =
        qoop_server::create_admin(&scratch, "admin@example.org", "Ada Admin", PASSWORD, START)
            .unwrap();
    let (mut ws, main) = qoop_core::Workspace::new();
    let card = new_id();
    let ops: Vec<qoop_core::Op> =
        serde_json::from_value(json!([create_card(&card, "From M3")])).unwrap();
    ws.record_all(main, ada.id, START, ops).unwrap();
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(M3_SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO members (id, email, name, role, color, password_hash, access_until, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                ada.id.0.to_string(),
                ada.email,
                ada.name,
                ada.role.as_str(),
                ada.color,
                ada.password_hash,
                ada.access_until,
                ada.created_at
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO workspace (id, json) VALUES (1, ?1)",
            rusqlite::params![serde_json::to_string(&ws).unwrap()],
        )
        .unwrap();
        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'todos'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 0);
    }

    let version = |path: &std::path::Path| -> i64 {
        rusqlite::Connection::open(path)
            .unwrap()
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(version(&path), 1);

    let todo = {
        let app = TestApp::with_store(Arc::new(SqliteStore::open(&path).unwrap()));
        let res = app.login("admin@example.org", PASSWORD).await;
        assert_eq!(res.status, StatusCode::OK, "the account is still there");
        let cookie = res.cookie();
        assert_eq!(app.main_branch(&cookie).await, main.0.to_string());
        let board = app
            .get(&format!("/api/branches/{}/board", main.0), Some(&cookie))
            .await;
        assert_eq!(board.body["seq"], 1);
        assert_eq!(
            board.body["entities"][&card]["fields"]["title"],
            json!({ "Text": "From M3" })
        );
        // The new table is there and works.
        let list = app.get("/api/todos", Some(&cookie)).await;
        assert_eq!(list.body, json!({ "todos": [] }));
        let res = app
            .post(
                "/api/todos",
                Some(&cookie),
                json!({ "owner": ada.id.0.to_string(), "text": "After the upgrade" }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        res.body["todo"].clone()
    };
    assert_eq!(version(&path), SCHEMA_VERSION);
    assert_eq!(SCHEMA_VERSION, 2);

    // Opening the upgraded file again changes nothing.
    let app = TestApp::with_store(Arc::new(SqliteStore::open(&path).unwrap()));
    let cookie = app.login("admin@example.org", PASSWORD).await.cookie();
    let list = app.get("/api/todos", Some(&cookie)).await;
    assert_eq!(list.body, json!({ "todos": [todo] }));
    assert_eq!(version(&path), SCHEMA_VERSION);
}

#[tokio::test]
async fn the_new_writes_need_the_origin_and_the_marker_header() {
    let w = world().await;
    let id = id_of(&w.add(&w.bea, &w.bea_id, "Guarded").await);
    let item = format!("/api/todos/{id}");
    let attempts = [
        (
            Method::POST,
            "/api/todos",
            json!({ "owner": w.bea_id, "text": "Forged" }),
        ),
        (Method::PATCH, item.as_str(), json!({ "text": "Forged" })),
        (Method::DELETE, item.as_str(), Value::Null),
    ];
    for (method, path, body) in attempts {
        // (Origin, X-Qoop-Request)
        let cases = [
            (Some("https://evil.example"), Some("1")),
            (None, Some("1")),
            (Some(ORIGIN), None),
            (Some(ORIGIN), Some("yes")),
        ];
        for (origin, marker) in cases {
            let mut b = Request::builder()
                .method(method.clone())
                .uri(path)
                .header(header::COOKIE, &w.bea)
                .header(header::CONTENT_TYPE, "application/json");
            if let Some(o) = origin {
                b = b.header(header::ORIGIN, o);
            }
            if let Some(m) = marker {
                b = b.header("x-qoop-request", m);
            }
            let res = w
                .app
                .send(b.body(Body::from(body.to_string())).unwrap())
                .await;
            assert_eq!(
                res.status,
                StatusCode::FORBIDDEN,
                "{method} {path} {origin:?} {marker:?}"
            );
            assert_eq!(res.code(), "forbidden_origin");
        }
    }
    let list = w.list(&w.bea).await;
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["text"], "Guarded");
    // Reading needs neither.
    let res = w.app.get("/api/todos", Some(&w.bea)).await;
    assert_eq!(res.status, StatusCode::OK);
}
