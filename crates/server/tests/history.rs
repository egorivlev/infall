mod common;

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use common::*;
use qoop_server::store::SqliteStore;
use serde_json::{Value, json};

/// An app with an Admin and three Changes on main: create A, create B, retitle A.
async fn app_with_history() -> (TestApp, String, String, String, String) {
    let app = TestApp::new();
    let admin = app.admin().await;
    let main = app.main_branch(&admin).await;
    let (a, b) = (new_id(), new_id());
    seed(&app, &admin, &main, &a, &b).await;
    (app, admin, main, a, b)
}

async fn seed(app: &TestApp, cookie: &str, main: &str, a: &str, b: &str) {
    let res = app
        .post(
            &format!("/api/branches/{main}/ops"),
            Some(cookie),
            json!({ "ops": [create_card(a, "A"), create_card(b, "B"), set_title(a, "A2")] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
}

async fn me(app: &TestApp, cookie: &str) -> Value {
    app.get("/api/me", Some(cookie)).await.body["member"]["id"].clone()
}

async fn board(app: &TestApp, cookie: &str, branch: &str, at: Option<u64>) -> Res {
    let path = match at {
        Some(at) => format!("/api/branches/{branch}/board?at={at}"),
        None => format!("/api/branches/{branch}/board"),
    };
    app.get(&path, Some(cookie)).await
}

/// Live entities and their fields: what "the same content" means for a Restore.
fn live_content(board: &Value) -> Value {
    let live: serde_json::Map<String, Value> = board["entities"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(_, e)| e["deleted"] == false)
        .map(|(id, e)| (id.clone(), e.clone()))
        .collect();
    Value::Object(live)
}

async fn guest(app: &TestApp, admin: &str) -> String {
    app.join(admin, "g@example.org", "guest", Some(START + 1_000_000))
        .await
}

#[tokio::test]
async fn the_board_can_be_read_at_any_moment_up_to_the_head() {
    let (app, admin, main, a, b) = app_with_history().await;
    let at0 = board(&app, &admin, &main, Some(0)).await;
    assert_eq!(at0.status, StatusCode::OK, "{}", at0.text);
    assert_eq!(
        at0.body,
        json!({ "branch": main, "seq": 0, "entities": {} })
    );
    let at1 = board(&app, &admin, &main, Some(1)).await;
    assert_eq!(at1.body["seq"], 1);
    assert_eq!(at1.body["entities"][&a]["fields"]["title"]["Text"], "A");
    assert!(at1.body["entities"].get(&b).is_none());
    let at3 = board(&app, &admin, &main, Some(3)).await;
    assert_eq!(at3.body, board(&app, &admin, &main, None).await.body);

    let past = board(&app, &admin, &main, Some(4)).await;
    assert_eq!(past.status, StatusCode::BAD_REQUEST);
    assert_eq!(past.code(), "bad_request");
    let junk = app
        .get(&format!("/api/branches/{main}/board?at=x"), Some(&admin))
        .await;
    assert_eq!(junk.status, StatusCode::BAD_REQUEST);
    let unknown = board(&app, &admin, &new_id(), Some(0)).await;
    assert_eq!(unknown.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_checkpoint_names_the_head_or_a_given_moment() {
    let (app, admin, main, _, _) = app_with_history().await;
    let author = me(&app, &admin).await;
    let path = format!("/api/branches/{main}/checkpoints");
    assert_eq!(
        app.get(&path, Some(&admin)).await.body,
        json!({ "checkpoints": [] })
    );

    let res = app
        .post(
            &path,
            Some(&admin),
            json!({ "name": "  Before the rewrite  " }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(
        res.body,
        json!({ "checkpoint": {
            "name": "Before the rewrite",
            "moment": { "branch": main, "seq": 3 },
            "author": author,
            "at": START,
        } })
    );
    app.clock.advance(5);
    let res = app
        .post(&path, Some(&admin), json!({ "name": "zeta", "seq": 1 }))
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body["checkpoint"]["moment"]["seq"], 1);
    assert_eq!(res.body["checkpoint"]["at"], START + 5);
    for (name, seq) in [("alpha", 1), ("start", 0)] {
        let res = app
            .post(&path, Some(&admin), json!({ "name": name, "seq": seq }))
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    }

    let list = app.get(&path, Some(&admin)).await;
    assert_eq!(list.status, StatusCode::OK);
    let names: Vec<(&str, u64)> = list.body["checkpoints"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["name"].as_str().unwrap(),
                c["moment"]["seq"].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        names,
        [
            ("start", 0),
            ("alpha", 1),
            ("zeta", 1),
            ("Before the rewrite", 3)
        ],
        "ordered by moment, then name"
    );

    let branches = app.get("/api/branches", Some(&admin)).await;
    assert_eq!(branches.body["branches"][0]["checkpoints"], 4);
    // A Checkpoint is not a Change.
    assert_eq!(branches.body["branches"][0]["seq"], 3);
}

#[tokio::test]
async fn a_new_branch_info_has_zero_checkpoints() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let branches = app.get("/api/branches", Some(&admin)).await;
    assert_eq!(branches.body["branches"][0]["checkpoints"], 0);
}

#[tokio::test]
async fn bad_checkpoint_requests_are_refused_and_record_nothing() {
    let (app, admin, main, _, _) = app_with_history().await;
    let path = format!("/api/branches/{main}/checkpoints");
    let long = "é".repeat(81);
    for body in [
        json!({ "name": "" }),
        json!({ "name": "   \t " }),
        json!({ "name": long }),
        json!({ "name": "two\nlines" }),
        json!({ "name": "bell\u{7}" }),
        json!({ "name": "past", "seq": 4 }),
        json!({ "name": "negative", "seq": -1 }),
        json!({ "seq": 1 }),
    ] {
        let res = app.post(&path, Some(&admin), body.clone()).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(res.code(), "bad_request", "{body}");
    }
    // 80 characters is allowed, and they are characters, not bytes.
    let res = app
        .post(&path, Some(&admin), json!({ "name": "é".repeat(80) }))
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);

    let res = app
        .post(
            &path,
            Some(&admin),
            json!({ "name": format!("  {}  ", "é".repeat(80)), "seq": 0 }),
        )
        .await;
    assert_eq!(res.status, StatusCode::CONFLICT, "{}", res.text);
    assert_eq!(res.code(), "name_taken");

    assert_eq!(
        app.get(&path, Some(&admin)).await.body["checkpoints"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let other = format!("/api/branches/{}/checkpoints", new_id());
    assert_eq!(
        app.get(&other, Some(&admin)).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        app.post(&other, Some(&admin), json!({ "name": "x" }))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        app.post(
            "/api/branches/not-a-uuid/checkpoints",
            Some(&admin),
            json!({ "name": "x" })
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn checkpoint_names_are_unique_per_branch_only() {
    let (app, admin, main, _, _) = app_with_history().await;
    let res = app
        .post(
            "/api/branches",
            Some(&admin),
            json!({ "name": "side", "from": { "branch": main, "seq": 3 } }),
        )
        .await;
    let side = res.body["branch"]["id"].as_str().unwrap().to_string();
    for branch in [&main, &side] {
        let res = app
            .post(
                &format!("/api/branches/{branch}/checkpoints"),
                Some(&admin),
                json!({ "name": "v1" }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    }
    let res = app
        .post(
            &format!("/api/branches/{side}/checkpoints"),
            Some(&admin),
            json!({ "name": "v1" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::CONFLICT);
    assert_eq!(res.code(), "name_taken");
}

#[tokio::test]
async fn restore_returns_the_board_to_an_earlier_moment() {
    let (app, admin, main, a, b) = app_with_history().await;
    let bea = app.join(&admin, "bea@example.org", "member", None).await;
    let bea_id = me(&app, &bea).await;
    let earlier = board(&app, &admin, &main, Some(1)).await.body;

    let res = app
        .post(
            &format!("/api/branches/{main}/restore"),
            Some(&bea),
            json!({ "to_seq": 1 }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let changes = res.body["changes"].as_array().unwrap();
    assert!(!changes.is_empty());
    assert_eq!(res.body["seq"], 3 + changes.len() as u64);
    let batch = changes[0]["origin"]["Restore"]["batch"].clone();
    assert!(batch.is_string());
    for c in changes {
        assert_eq!(c["author"], bea_id);
        assert_eq!(c["at"], START);
        assert_eq!(
            c["origin"],
            json!({ "Restore": { "batch": batch, "to_seq": 1 } })
        );
    }

    let now = board(&app, &admin, &main, None).await.body;
    assert_eq!(now["seq"], res.body["seq"]);
    assert_eq!(live_content(&now), live_content(&earlier));
    assert_eq!(now["entities"][&a]["fields"]["title"]["Text"], "A");
    // Created after that moment: deleted, not absent.
    assert_eq!(now["entities"][&b]["deleted"], true);

    // The Changes are in the log like any others.
    let tail = app
        .get(
            &format!("/api/branches/{main}/changes?after=3"),
            Some(&admin),
        )
        .await;
    assert_eq!(tail.body["changes"], res.body["changes"]);
    // History is append-only: the earlier moments still read the same.
    assert_eq!(board(&app, &admin, &main, Some(1)).await.body, earlier);
}

#[tokio::test]
async fn a_restore_that_changes_nothing_returns_no_changes() {
    let (app, admin, main, _, _) = app_with_history().await;
    let path = format!("/api/branches/{main}/restore");
    let res = app.post(&path, Some(&admin), json!({ "to_seq": 3 })).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body, json!({ "seq": 3, "changes": [] }));

    for body in [json!({ "to_seq": 4 }), json!({ "to_seq": -1 }), json!({})] {
        let res = app.post(&path, Some(&admin), body.clone()).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(res.code(), "bad_request");
    }
    assert_eq!(board(&app, &admin, &main, None).await.body["seq"], 3);
    assert_eq!(
        app.post(
            &format!("/api/branches/{}/restore", new_id()),
            Some(&admin),
            json!({ "to_seq": 0 })
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn forking_creates_a_branch_that_starts_from_the_parent_moment() {
    let (app, admin, main, a, b) = app_with_history().await;
    let bea = app.join(&admin, "bea@example.org", "member", None).await;
    let bea_id = me(&app, &bea).await;
    let parent_at_2 = board(&app, &admin, &main, Some(2)).await.body;

    let res = app
        .post(
            "/api/branches",
            Some(&bea),
            json!({ "name": "  what if  ", "from": { "branch": main, "seq": 2 } }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let side = res.body["branch"]["id"].as_str().unwrap().to_string();
    assert_eq!(
        res.body,
        json!({ "branch": {
            "id": side,
            "name": "what if",
            "seq": 0,
            "parent": { "branch": main, "seq": 2 },
            "created_by": bea_id,
            "created_at": START,
            "checkpoints": 0,
        } })
    );
    let list = app.get("/api/branches", Some(&admin)).await;
    let listed = list.body["branches"].as_array().unwrap();
    assert_eq!(listed.len(), 2);
    assert!(listed.contains(&res.body["branch"]));

    // The parent moving on does not move the fork point.
    app.post(
        &format!("/api/branches/{main}/ops"),
        Some(&admin),
        json!({ "ops": [set_title(&b, "B on main")] }),
    )
    .await;
    let at0 = board(&app, &admin, &side, Some(0)).await;
    assert_eq!(at0.status, StatusCode::OK, "{}", at0.text);
    assert_eq!(at0.body["branch"], side.as_str());
    assert_eq!(at0.body["seq"], 0);
    assert_eq!(at0.body["entities"], parent_at_2["entities"]);
    assert_eq!(at0.body["entities"][&a]["fields"]["title"]["Text"], "A");

    // Edits on the new Branch stay there.
    let res = app
        .post(
            &format!("/api/branches/{side}/ops"),
            Some(&bea),
            json!({ "ops": [set_title(&a, "A on side")] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body["seq"], 1);
    assert_eq!(
        board(&app, &admin, &side, None).await.body["entities"][&a]["fields"]["title"]["Text"],
        "A on side"
    );
    assert_eq!(
        board(&app, &admin, &main, None).await.body["entities"][&a]["fields"]["title"]["Text"],
        "A2"
    );
    assert_eq!(
        board(&app, &admin, &side, Some(0)).await.body["entities"],
        parent_at_2["entities"]
    );
    assert_eq!(
        board(&app, &admin, &side, Some(2)).await.status,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn bad_fork_requests_are_refused_and_create_nothing() {
    let (app, admin, main, _, _) = app_with_history().await;
    let from = json!({ "branch": main, "seq": 3 });
    for body in [
        json!({ "name": "", "from": from }),
        json!({ "name": "  ", "from": from }),
        json!({ "name": "é".repeat(61), "from": from }),
        json!({ "name": "tab\there", "from": from }),
        json!({ "name": "past the head", "from": { "branch": main, "seq": 4 } }),
        json!({ "name": "no such branch", "from": { "branch": new_id(), "seq": 0 } }),
        json!({ "name": "not a moment", "from": { "branch": "nope", "seq": 0 } }),
        json!({ "name": "no moment" }),
        json!({ "from": from }),
    ] {
        let res = app.post("/api/branches", Some(&admin), body.clone()).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(res.code(), "bad_request", "{body}");
    }
    for name in ["main", " main "] {
        let res = app
            .post(
                "/api/branches",
                Some(&admin),
                json!({ "name": name, "from": from }),
            )
            .await;
        assert_eq!(res.status, StatusCode::CONFLICT);
        assert_eq!(res.code(), "name_taken");
    }
    let res = app
        .post(
            "/api/branches",
            Some(&admin),
            json!({ "name": "é".repeat(60), "from": from }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let res = app
        .post(
            "/api/branches",
            Some(&admin),
            json!({ "name": "é".repeat(60), "from": from }),
        )
        .await;
    assert_eq!(res.code(), "name_taken");
    assert_eq!(
        app.get("/api/branches", Some(&admin)).await.body["branches"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn guests_are_refused_everything_in_history() {
    let (app, admin, main, _, _) = app_with_history().await;
    let guest = guest(&app, &admin).await;
    let forbidden = |res: Res, what: &str| {
        assert_eq!(res.status, StatusCode::FORBIDDEN, "{what}: {}", res.text);
        assert_eq!(res.code(), "forbidden", "{what}");
    };

    forbidden(board(&app, &guest, &main, Some(0)).await, "board?at");
    forbidden(board(&app, &guest, &main, Some(99)).await, "board?at past");
    forbidden(
        app.get(&format!("/api/branches/{main}/checkpoints"), Some(&guest))
            .await,
        "list checkpoints",
    );
    forbidden(
        app.post(
            &format!("/api/branches/{main}/checkpoints"),
            Some(&guest),
            json!({ "name": "mine" }),
        )
        .await,
        "create checkpoint",
    );
    forbidden(
        app.post(
            &format!("/api/branches/{main}/restore"),
            Some(&guest),
            json!({ "to_seq": 0 }),
        )
        .await,
        "restore",
    );
    forbidden(
        app.post(
            "/api/branches",
            Some(&guest),
            json!({ "name": "mine", "from": { "branch": main, "seq": 0 } }),
        )
        .await,
        "fork",
    );
    // Nor do they learn whether another Branch exists.
    forbidden(
        app.get(
            &format!("/api/branches/{}/checkpoints", new_id()),
            Some(&guest),
        )
        .await,
        "unknown branch",
    );

    // Nothing happened.
    let branches = app.get("/api/branches", Some(&admin)).await;
    assert_eq!(branches.body["branches"].as_array().unwrap().len(), 1);
    assert_eq!(branches.body["branches"][0]["seq"], 3);
    assert_eq!(branches.body["branches"][0]["checkpoints"], 0);

    // The present Board still reads; the Changes behind it do not (M6).
    let head = board(&app, &guest, &main, None).await;
    assert_eq!(head.status, StatusCode::OK);
    assert_eq!(head.body["seq"], 3);
    forbidden(
        app.get(&format!("/api/branches/{main}/changes"), Some(&guest))
            .await,
        "changes",
    );
}

#[tokio::test]
async fn signed_out_callers_are_refused() {
    let (app, admin, main, _, _) = app_with_history().await;
    drop(admin);
    for path in [
        format!("/api/branches/{main}/board?at=0"),
        format!("/api/branches/{main}/checkpoints"),
    ] {
        assert_eq!(app.get(&path, None).await.status, StatusCode::UNAUTHORIZED);
    }
    for (path, body) in [
        (
            format!("/api/branches/{main}/checkpoints"),
            json!({ "name": "x" }),
        ),
        (
            format!("/api/branches/{main}/restore"),
            json!({ "to_seq": 0 }),
        ),
        (
            "/api/branches".to_string(),
            json!({ "name": "x", "from": { "branch": main, "seq": 0 } }),
        ),
    ] {
        let res = app.post(&path, None, body).await;
        assert_eq!(res.status, StatusCode::UNAUTHORIZED, "{path}");
    }
}

#[tokio::test]
async fn the_new_posts_need_the_origin_and_request_headers() {
    let (app, admin, main, _, _) = app_with_history().await;
    let posts = [
        (
            format!("/api/branches/{main}/checkpoints"),
            json!({ "name": "x" }),
        ),
        (
            format!("/api/branches/{main}/restore"),
            json!({ "to_seq": 0 }),
        ),
        (
            "/api/branches".to_string(),
            json!({ "name": "x", "from": { "branch": main, "seq": 0 } }),
        ),
    ];
    for (path, body) in &posts {
        let base = || {
            Request::builder()
                .method(Method::POST)
                .uri(path)
                .header(header::COOKIE, &admin)
                .header(header::CONTENT_TYPE, "application/json")
        };
        let attempts = [
            ("no Origin", base().header("x-qoop-request", "1")),
            (
                "foreign Origin",
                base()
                    .header(header::ORIGIN, "https://evil.example")
                    .header("x-qoop-request", "1"),
            ),
            ("no X-Qoop-Request", base().header(header::ORIGIN, ORIGIN)),
        ];
        for (what, req) in attempts {
            let res = app
                .send(req.body(Body::from(body.to_string())).unwrap())
                .await;
            assert_eq!(res.status, StatusCode::FORBIDDEN, "{path} with {what}");
            assert_eq!(res.code(), "forbidden_origin", "{path} with {what}");
        }
    }
    let branches = app.get("/api/branches", Some(&admin)).await;
    assert_eq!(branches.body["branches"].as_array().unwrap().len(), 1);
    assert_eq!(branches.body["branches"][0]["seq"], 3);
    assert_eq!(branches.body["branches"][0]["checkpoints"], 0);
}

#[tokio::test]
async fn history_survives_a_restart_on_the_same_sqlite_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("qoop.db");
    let (a, b) = (new_id(), new_id());
    let (main, side, before) = {
        let app = TestApp::with_store(Arc::new(SqliteStore::open(&path).unwrap()));
        let admin = app.admin().await;
        let main = app.main_branch(&admin).await;
        seed(&app, &admin, &main, &a, &b).await;
        let res = app
            .post(
                &format!("/api/branches/{main}/checkpoints"),
                Some(&admin),
                json!({ "name": "first card", "seq": 1 }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        let res = app
            .post(
                "/api/branches",
                Some(&admin),
                json!({ "name": "side", "from": { "branch": main, "seq": 2 } }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        let side = res.body["branch"]["id"].as_str().unwrap().to_string();
        let res = app
            .post(
                &format!("/api/branches/{side}/checkpoints"),
                Some(&admin),
                json!({ "name": "forked" }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        let res = app
            .post(
                &format!("/api/branches/{main}/restore"),
                Some(&admin),
                json!({ "to_seq": 1 }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        assert!(!res.body["changes"].as_array().unwrap().is_empty());
        let before = snapshot(&app, &admin, &main, &side).await;
        (main, side, before)
    };
    let app = TestApp::with_store(Arc::new(SqliteStore::open(&path).unwrap()));
    let cookie = app.login("admin@example.org", PASSWORD).await.cookie();
    let after = snapshot(&app, &cookie, &main, &side).await;
    assert_eq!(after, before);
    assert_eq!(after["branches"]["branches"].as_array().unwrap().len(), 2);
    assert_eq!(
        after["main_checkpoints"]["checkpoints"][0]["name"],
        "first card"
    );
    assert_eq!(
        after["side_checkpoints"]["checkpoints"][0]["name"],
        "forked"
    );
    assert_eq!(
        after["main_changes"]["changes"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["origin"]["Restore"]["to_seq"],
        1
    );
    assert_eq!(after["main_board"]["entities"][&b]["deleted"], true);
}

/// Everything section 9 lets a Member read, in one value.
async fn snapshot(app: &TestApp, cookie: &str, main: &str, side: &str) -> Value {
    let get = async |path: String| {
        let res = app.get(&path, Some(cookie)).await;
        assert_eq!(res.status, StatusCode::OK, "{path}: {}", res.text);
        res.body
    };
    json!({
        "branches": get("/api/branches".to_string()).await,
        "main_board": get(format!("/api/branches/{main}/board")).await,
        "main_at_1": get(format!("/api/branches/{main}/board?at=1")).await,
        "main_changes": get(format!("/api/branches/{main}/changes")).await,
        "main_checkpoints": get(format!("/api/branches/{main}/checkpoints")).await,
        "side_board": get(format!("/api/branches/{side}/board")).await,
        "side_at_0": get(format!("/api/branches/{side}/board?at=0")).await,
        "side_checkpoints": get(format!("/api/branches/{side}/checkpoints")).await,
    })
}
