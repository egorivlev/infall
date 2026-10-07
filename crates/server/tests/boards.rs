mod common;

use std::sync::Arc;

use axum::http::StatusCode;
use common::*;
use qoop_core::{BranchId, MemberId, Moment, Workspace};
use qoop_server::store::{MemoryStore, SqliteStore, Store};
use serde_json::{Value, json};

#[tokio::test]
async fn branches_lists_main_with_its_head() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let res = app.get("/api/branches", Some(&admin)).await;
    assert_eq!(res.status, StatusCode::OK);
    let branches = res.body["branches"].as_array().unwrap();
    assert_eq!(branches.len(), 1);
    assert_eq!(branches[0]["name"], "main");
    assert_eq!(branches[0]["seq"], 0);
    assert!(branches[0].get("parent").is_none());
    assert_eq!(
        app.get("/api/branches", None).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn posting_ops_applies_a_batch_authored_by_the_caller() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let me = app.get("/api/me", Some(&admin)).await.body["member"]["id"].clone();
    let main = app.main_branch(&admin).await;
    let (a, b) = (new_id(), new_id());
    let res = app
        .post(
            &format!("/api/branches/{main}/ops"),
            Some(&admin),
            json!({ "ops": [create_card(&a, "A"), create_card(&b, "B"), set_title(&a, "A2")] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body["seq"], 3);
    let changes = res.body["changes"].as_array().unwrap();
    assert_eq!(changes.len(), 3);
    for c in changes {
        assert_eq!(c["author"], me);
        assert_eq!(c["at"], START);
        assert_eq!(c["origin"], "Edit");
    }
    assert_eq!(changes[2]["op"], set_title(&a, "A2"));

    let board = app
        .get(&format!("/api/branches/{main}/board"), Some(&admin))
        .await;
    assert_eq!(board.status, StatusCode::OK);
    assert_eq!(board.body["branch"], main.as_str());
    assert_eq!(board.body["seq"], 3);
    assert_eq!(
        board.body["entities"][&a],
        json!({ "kind": "Card", "fields": { "title": { "Text": "A2" } }, "deleted": false })
    );
    assert_eq!(
        app.get("/api/branches", Some(&admin)).await.body["branches"][0]["seq"],
        3
    );
}

#[tokio::test]
async fn the_board_includes_deleted_entities() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let main = app.main_branch(&admin).await;
    let a = new_id();
    let res = app
        .post(
            &format!("/api/branches/{main}/ops"),
            Some(&admin),
            json!({ "ops": [create_card(&a, "A"), { "Delete": { "entity": a } }] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    let board = app
        .get(&format!("/api/branches/{main}/board"), Some(&admin))
        .await;
    assert_eq!(board.body["entities"][&a]["deleted"], true);
}

#[tokio::test]
async fn a_rejected_op_applies_nothing_and_reports_the_core_error() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let main = app.main_branch(&admin).await;
    let (a, b) = (new_id(), new_id());
    let ops = format!("/api/branches/{main}/ops");
    app.post(&ops, Some(&admin), json!({ "ops": [create_card(&a, "A")] }))
        .await;
    let res = app
        .post(
            &ops,
            Some(&admin),
            json!({ "ops": [create_card(&b, "B"), create_card(&a, "again")] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::CONFLICT);
    assert_eq!(res.code(), "rejected");
    assert_eq!(res.body["error"]["detail"], json!({ "AlreadyExists": a }));
    let board = app
        .get(&format!("/api/branches/{main}/board"), Some(&admin))
        .await;
    assert_eq!(board.body["seq"], 1);
    assert!(board.body["entities"].get(&b).is_none());

    // Schema violations are core refusals too.
    let res = app
        .post(&ops, Some(&admin), json!({ "ops": [{ "Set": { "entity": a, "field": "colour", "value": { "Text": "red" } } }] }))
        .await;
    assert_eq!(res.status, StatusCode::CONFLICT);
    assert!(
        res.body["error"]["detail"]["Schema"].is_object(),
        "{}",
        res.text
    );
}

#[tokio::test]
async fn ops_must_number_between_one_and_two_hundred() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let main = app.main_branch(&admin).await;
    let ops = format!("/api/branches/{main}/ops");
    let res = app.post(&ops, Some(&admin), json!({ "ops": [] })).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.code(), "bad_request");
    let many: Vec<Value> = (0..201)
        .map(|i| create_card(&new_id(), &format!("{i}")))
        .collect();
    let res = app.post(&ops, Some(&admin), json!({ "ops": many })).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    let many: Vec<Value> = (0..200)
        .map(|i| create_card(&new_id(), &format!("{i}")))
        .collect();
    let res = app.post(&ops, Some(&admin), json!({ "ops": many })).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body["seq"], 200);
    // An op the wire format does not know is a 400, not a 409.
    let res = app
        .post(&ops, Some(&admin), json!({ "ops": [{ "Explode": {} }] }))
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn unknown_branches_are_404() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let other = new_id();
    for path in [
        format!("/api/branches/{other}/board"),
        format!("/api/branches/{other}/changes"),
        "/api/branches/not-a-uuid/board".to_string(),
    ] {
        let res = app.get(&path, Some(&admin)).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "{path}");
        assert_eq!(res.code(), "not_found");
    }
    let res = app
        .post(
            &format!("/api/branches/{other}/ops"),
            Some(&admin),
            json!({ "ops": [create_card(&new_id(), "A")] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn changes_after_returns_the_tail_and_the_head() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let main = app.main_branch(&admin).await;
    let a = new_id();
    app.post(
        &format!("/api/branches/{main}/ops"),
        Some(&admin),
        json!({ "ops": [create_card(&a, "A"), set_title(&a, "B"), set_title(&a, "C")] }),
    )
    .await;
    let res = app
        .get(
            &format!("/api/branches/{main}/changes?after=1"),
            Some(&admin),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body["seq"], 3);
    let changes = res.body["changes"].as_array().unwrap();
    assert_eq!(changes.len(), 2);
    assert_eq!(changes[0]["op"], set_title(&a, "B"));
    let all = app
        .get(&format!("/api/branches/{main}/changes"), Some(&admin))
        .await;
    assert_eq!(all.body["changes"].as_array().unwrap().len(), 3);
    let none = app
        .get(
            &format!("/api/branches/{main}/changes?after=3"),
            Some(&admin),
        )
        .await;
    assert_eq!(none.body, json!({ "seq": 3, "changes": [] }));
    let past = app
        .get(
            &format!("/api/branches/{main}/changes?after=4"),
            Some(&admin),
        )
        .await;
    assert_eq!(past.status, StatusCode::BAD_REQUEST);
    let junk = app
        .get(
            &format!("/api/branches/{main}/changes?after=x"),
            Some(&admin),
        )
        .await;
    assert_eq!(junk.status, StatusCode::BAD_REQUEST);
    assert_eq!(junk.code(), "bad_request");
}

/// A store whose Workspace holds `main` and a second Branch `side`.
fn store_with_a_side_branch() -> (Arc<dyn Store>, BranchId) {
    let (mut ws, main) = Workspace::new();
    let side = ws
        .fork(
            "side",
            Moment {
                branch: main,
                seq: 0,
            },
            MemberId::new(),
            1,
        )
        .unwrap();
    let store = MemoryStore::new();
    store.save_workspace(&ws).unwrap();
    (Arc::new(store), side)
}

#[tokio::test]
async fn guests_read_only_main_and_cannot_post_ops() {
    let (store, side) = store_with_a_side_branch();
    let app = TestApp::with_store(store);
    let admin = app.admin().await;
    let guest = app
        .join(&admin, "g@example.org", "guest", Some(START + 1_000_000))
        .await;
    let main = app.main_branch(&admin).await;
    let side = side.0.to_string();

    let branches = app.get("/api/branches", Some(&guest)).await;
    let names: Vec<&str> = branches.body["branches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["main"]);
    assert_eq!(
        app.get("/api/branches", Some(&admin)).await.body["branches"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    assert_eq!(
        app.get(&format!("/api/branches/{main}/board"), Some(&guest))
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        app.get(&format!("/api/branches/{main}/changes"), Some(&guest))
            .await
            .status,
        StatusCode::OK
    );
    for path in [
        format!("/api/branches/{side}/board"),
        format!("/api/branches/{side}/changes"),
        format!("/api/branches/{}/board", new_id()),
    ] {
        let res = app.get(&path, Some(&guest)).await;
        assert_eq!(res.status, StatusCode::FORBIDDEN, "{path}");
        assert_eq!(res.code(), "forbidden");
    }
    assert_eq!(
        app.get(&format!("/api/branches/{side}/board"), Some(&admin))
            .await
            .status,
        StatusCode::OK
    );

    let res = app
        .post(
            &format!("/api/branches/{main}/ops"),
            Some(&guest),
            json!({ "ops": [create_card(&new_id(), "A")] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.code(), "forbidden");
    assert_eq!(
        app.get(&format!("/api/branches/{main}/board"), Some(&admin))
            .await
            .body["seq"],
        0
    );
}

#[tokio::test]
async fn members_can_post_ops() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let member = app.join(&admin, "bea@example.org", "member", None).await;
    let main = app.main_branch(&member).await;
    let res = app
        .post(
            &format!("/api/branches/{main}/ops"),
            Some(&member),
            json!({ "ops": [create_card(&new_id(), "A")] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
}

#[tokio::test]
async fn the_board_survives_a_restart_on_the_same_sqlite_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("qoop.db");
    let a = new_id();
    let (main, board_before) = {
        let app = TestApp::with_store(Arc::new(SqliteStore::open(&path).unwrap()));
        let admin = app.admin().await;
        let main = app.main_branch(&admin).await;
        let res = app
            .post(
                &format!("/api/branches/{main}/ops"),
                Some(&admin),
                json!({ "ops": [create_card(&a, "Persisted"), set_title(&a, "Persisted 2")] }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK);
        let board = app
            .get(&format!("/api/branches/{main}/board"), Some(&admin))
            .await;
        (main, board.body)
    };
    let app = TestApp::with_store(Arc::new(SqliteStore::open(&path).unwrap()));
    let res = app.login("admin@example.org", PASSWORD).await;
    assert_eq!(res.status, StatusCode::OK);
    let cookie = res.cookie();
    assert_eq!(app.main_branch(&cookie).await, main, "main keeps its id");
    let board = app
        .get(&format!("/api/branches/{main}/board"), Some(&cookie))
        .await;
    assert_eq!(board.body, board_before);
    assert_eq!(
        board.body["entities"][&a]["fields"]["title"]["Text"],
        "Persisted 2"
    );
}

#[tokio::test]
async fn the_branch_id_is_stable_across_restarts_before_any_edit() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("qoop.db");
    let first = {
        let app = TestApp::with_store(Arc::new(SqliteStore::open(&path).unwrap()));
        let admin = app.admin().await;
        app.main_branch(&admin).await
    };
    let app = TestApp::with_store(Arc::new(SqliteStore::open(&path).unwrap()));
    let cookie = app.login("admin@example.org", PASSWORD).await.cookie();
    assert_eq!(app.main_branch(&cookie).await, first);
}

#[test]
fn the_sqlite_schema_is_versioned_and_in_wal_mode() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("qoop.db");
    drop(SqliteStore::open(&path).unwrap());
    // Opening again runs no migration twice.
    drop(SqliteStore::open(&path).unwrap());
    let conn = rusqlite::Connection::open(&path).unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, qoop_server::store::SCHEMA_VERSION);
    let mode: String = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
    // A file from a newer binary is refused rather than misread.
    conn.execute_batch("PRAGMA user_version = 99").unwrap();
    drop(conn);
    assert!(SqliteStore::open(&path).is_err());
}

/// A store whose snapshot writes always fail.
struct FailingStore(MemoryStore);

impl Store for FailingStore {
    fn load_workspace(&self) -> qoop_server::store::StoreResult<Option<Workspace>> {
        self.0.load_workspace()
    }
    fn save_workspace(&self, ws: &Workspace) -> qoop_server::store::StoreResult<()> {
        if self.0.load_workspace()?.is_none() {
            return self.0.save_workspace(ws);
        }
        Err(qoop_server::store::StoreError::Backend(
            "disk full at /secret/path".to_string(),
        ))
    }
    fn insert_member(
        &self,
        m: &qoop_server::store::MemberRecord,
    ) -> qoop_server::store::StoreResult<()> {
        self.0.insert_member(m)
    }
    fn member(
        &self,
        id: MemberId,
    ) -> qoop_server::store::StoreResult<Option<qoop_server::store::MemberRecord>> {
        self.0.member(id)
    }
    fn member_by_email(
        &self,
        e: &str,
    ) -> qoop_server::store::StoreResult<Option<qoop_server::store::MemberRecord>> {
        self.0.member_by_email(e)
    }
    fn members(&self) -> qoop_server::store::StoreResult<Vec<qoop_server::store::MemberRecord>> {
        self.0.members()
    }
    fn member_count(&self) -> qoop_server::store::StoreResult<usize> {
        self.0.member_count()
    }
    fn delete_member(&self, id: MemberId) -> qoop_server::store::StoreResult<bool> {
        self.0.delete_member(id)
    }
    fn set_password(&self, id: MemberId, h: &str) -> qoop_server::store::StoreResult<bool> {
        self.0.set_password(id, h)
    }
    fn insert_session(
        &self,
        t: &str,
        m: MemberId,
        e: i64,
        n: i64,
    ) -> qoop_server::store::StoreResult<()> {
        self.0.insert_session(t, m, e, n)
    }
    fn session(
        &self,
        t: &str,
        n: i64,
    ) -> qoop_server::store::StoreResult<Option<(qoop_server::store::MemberRecord, i64)>> {
        self.0.session(t, n)
    }
    fn extend_session(&self, t: &str, e: i64) -> qoop_server::store::StoreResult<()> {
        self.0.extend_session(t, e)
    }
    fn delete_session(&self, t: &str) -> qoop_server::store::StoreResult<()> {
        self.0.delete_session(t)
    }
    fn insert_invite(
        &self,
        i: &qoop_server::store::InviteRecord,
    ) -> qoop_server::store::StoreResult<()> {
        self.0.insert_invite(i)
    }
    fn invite_by_token_hash(
        &self,
        t: &str,
    ) -> qoop_server::store::StoreResult<Option<qoop_server::store::InviteRecord>> {
        self.0.invite_by_token_hash(t)
    }
    fn pending_invites(
        &self,
        n: i64,
    ) -> qoop_server::store::StoreResult<Vec<qoop_server::store::InviteRecord>> {
        self.0.pending_invites(n)
    }
    fn delete_invite(&self, id: uuid::Uuid, n: i64) -> qoop_server::store::StoreResult<bool> {
        self.0.delete_invite(id, n)
    }
    fn accept_invite(
        &self,
        i: uuid::Uuid,
        m: &qoop_server::store::MemberRecord,
        n: i64,
    ) -> qoop_server::store::StoreResult<()> {
        self.0.accept_invite(i, m, n)
    }

    fn todos(&self) -> qoop_server::store::StoreResult<Vec<qoop_server::store::TodoRecord>> {
        self.0.todos()
    }
    fn todo(
        &self,
        id: uuid::Uuid,
    ) -> qoop_server::store::StoreResult<Option<qoop_server::store::TodoRecord>> {
        self.0.todo(id)
    }
    fn insert_todo(
        &self,
        t: &qoop_server::store::TodoRecord,
    ) -> qoop_server::store::StoreResult<bool> {
        self.0.insert_todo(t)
    }
    fn update_todo(
        &self,
        t: &qoop_server::store::TodoRecord,
    ) -> qoop_server::store::StoreResult<bool> {
        self.0.update_todo(t)
    }
    fn delete_todo(&self, id: uuid::Uuid) -> qoop_server::store::StoreResult<bool> {
        self.0.delete_todo(id)
    }
}

#[tokio::test]
async fn a_failed_persist_leaves_memory_unchanged_and_hides_the_cause() {
    let app = TestApp::with_store(Arc::new(FailingStore(MemoryStore::new())));
    let admin = app.admin().await;
    let main = app.main_branch(&admin).await;
    let res = app
        .post(
            &format!("/api/branches/{main}/ops"),
            Some(&admin),
            json!({ "ops": [create_card(&new_id(), "A")] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(res.code(), "internal");
    assert!(!res.text.contains("secret"), "{}", res.text);
    assert!(!res.text.contains("disk full"));
    let board = app
        .get(&format!("/api/branches/{main}/board"), Some(&admin))
        .await;
    assert_eq!(board.body["seq"], 0);
}

#[tokio::test]
async fn a_failed_persist_leaves_history_unchanged() {
    let app = TestApp::with_store(Arc::new(FailingStore(MemoryStore::new())));
    let admin = app.admin().await;
    let main = app.main_branch(&admin).await;
    for (path, body) in [
        (
            format!("/api/branches/{main}/checkpoints"),
            json!({ "name": "v1" }),
        ),
        (
            format!("/api/branches/{main}/restore"),
            json!({ "to_seq": 0 }),
        ),
        (
            "/api/branches".to_string(),
            json!({ "name": "side", "from": { "branch": main, "seq": 0 } }),
        ),
    ] {
        let res = app.post(&path, Some(&admin), body).await;
        assert_eq!(res.status, StatusCode::INTERNAL_SERVER_ERROR, "{path}");
        assert_eq!(res.code(), "internal");
        assert!(!res.text.contains("secret"), "{}", res.text);
    }
    let branches = app.get("/api/branches", Some(&admin)).await;
    assert_eq!(branches.body["branches"].as_array().unwrap().len(), 1);
    assert_eq!(branches.body["branches"][0]["checkpoints"], 0);
}

#[tokio::test]
async fn a_text_value_may_hold_at_most_100_000_characters() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let main = app.main_branch(&admin).await;
    let ops = format!("/api/branches/{main}/ops");
    let at_limit = "x".repeat(100_000);
    let over = "x".repeat(100_001);

    // `Create` fields.
    let a = new_id();
    let res = app
        .post(
            &ops,
            Some(&admin),
            json!({ "ops": [create_card(&a, &over)] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.code(), "bad_request");
    let res = app
        .post(
            &ops,
            Some(&admin),
            json!({ "ops": [create_card(&a, &at_limit)] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.code());
    assert_eq!(res.body["seq"], 1);

    // `Set` values; one long value refuses the whole request.
    let res = app
        .post(
            &ops,
            Some(&admin),
            json!({ "ops": [set_title(&a, "short"), set_title(&a, &over)] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.code(), "bad_request");
    let res = app
        .post(
            &ops,
            Some(&admin),
            json!({ "ops": [{ "Set": { "entity": a, "field": "summary", "value": { "Text": at_limit } } }] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.code());
    assert_eq!(res.body["seq"], 2);

    // Characters are counted, not bytes; and every kind is covered.
    let wide_ok = "й".repeat(100_000);
    let wide_over = "й".repeat(100_001);
    let block = |id: &str, text: &str| {
        json!({ "Create": { "entity": id, "kind": "Block", "fields": {
            "card": { "Ref": a }, "type": { "Text": "text" }, "text": { "Text": text }, "order": { "Text": "a" }
        } } })
    };
    let b = new_id();
    let res = app
        .post(
            &ops,
            Some(&admin),
            json!({ "ops": [block(&b, &wide_over)] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.code(), "bad_request");
    let res = app
        .post(&ops, Some(&admin), json!({ "ops": [block(&b, &wide_ok)] }))
        .await;
    assert_eq!(
        res.status,
        StatusCode::OK,
        "{} {}",
        res.code(),
        res.body["error"]["detail"]
    );
    assert_eq!(res.body["seq"], 3);
    let s = new_id();
    let res = app
        .post(
            &ops,
            Some(&admin),
            json!({ "ops": [{ "Create": { "entity": s, "kind": "Source", "fields": { "note": { "Text": wide_over } } } }] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);

    // Nothing refused was applied.
    let changes = app
        .get(&format!("/api/branches/{main}/changes"), Some(&admin))
        .await;
    assert_eq!(changes.body["seq"], 3);
}
