//! M18 — Comments and the For you list (docs/specs/team-move.md, decision 9 and Contract B;
//! api.md §19): permissions, mentions, limits, Guests, the live frames, and Local
//! Workspaces. Their survival through Workspace files is in tests/team_move.rs.

mod common;

use std::sync::Arc;
use std::time::Duration;

use axum::http::{Method, StatusCode};
use common::*;
use futures_util::{SinkExt, StreamExt};
use infall_server::local::{Preset, build_local_app, local_config};
use infall_server::store::{MemoryStore, SqliteStore, Store};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

struct World {
    app: TestApp,
    ada: String,
    bo: String,
    cy: String,
    guest: String,
    ada_id: String,
    bo_id: String,
    cy_id: String,
    guest_id: String,
}

async fn id_of(app: &TestApp, cookie: &str) -> String {
    app.get("/api/me", Some(cookie)).await.body["member"]["id"]
        .as_str()
        .unwrap()
        .to_string()
}

async fn world() -> World {
    world_on(Arc::new(MemoryStore::new())).await
}

/// The same on SQLite, as a server runs.
async fn sqlite_world() -> World {
    world_on(Arc::new(SqliteStore::open_in_memory().unwrap())).await
}

async fn world_on(store: Arc<dyn Store>) -> World {
    let app = TestApp::with_store(store);
    let ada = app.admin().await;
    let bo = app.join(&ada, "bo@example.org", "member", None).await;
    let cy = app.join(&ada, "cy@example.org", "member", None).await;
    let guest = app
        .join(&ada, "gus@example.org", "guest", Some(START + 100_000_000))
        .await;
    World {
        ada_id: id_of(&app, &ada).await,
        bo_id: id_of(&app, &bo).await,
        cy_id: id_of(&app, &cy).await,
        guest_id: id_of(&app, &guest).await,
        app,
        ada,
        bo,
        cy,
        guest,
    }
}

async fn comment(w: &World, cookie: &str, card: &str, text: &str, mentions: Value) -> Res {
    w.app
        .post(
            &format!("/api/cards/{card}/comments"),
            Some(cookie),
            json!({ "text": text, "mentions": mentions }),
        )
        .await
}

#[tokio::test]
async fn a_thread_is_written_read_edited_resolved_and_deleted_by_the_rules() {
    for w in [world().await, sqlite_world().await] {
        a_thread_is_written_read_edited_resolved_and_deleted_by_the_rules_on(w).await;
    }
}

async fn a_thread_is_written_read_edited_resolved_and_deleted_by_the_rules_on(w: World) {
    // A Card id that is on no Branch: a thread outlives its Card.
    let card = new_id();
    let res = comment(
        &w,
        &w.bo,
        &card,
        "  @Ada have a look  ",
        json!([w.ada_id, w.ada_id]),
    )
    .await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.text);
    let first = res.body.clone();
    assert_eq!(first["author"], w.bo_id);
    assert_eq!(first["text"], "@Ada have a look");
    assert_eq!(first["mentions"], json!([w.ada_id]));
    assert_eq!(first["edited_at"], Value::Null);
    assert_eq!(first["created_at"], START);
    let keys: Vec<&String> = first.as_object().unwrap().keys().collect();
    assert_eq!(
        keys,
        [
            "author",
            "created_at",
            "edited_at",
            "id",
            "mentions",
            "text"
        ]
    );
    w.app.clock.advance(10);
    let second = comment(&w, &w.cy, &card, "Me too", json!([])).await.body;

    let thread = w
        .app
        .get(&format!("/api/cards/{card}/comments"), Some(&w.ada))
        .await;
    assert_eq!(thread.status, StatusCode::OK);
    assert_eq!(
        thread.body,
        json!({ "resolved": false, "comments": [first, second] })
    );
    let empty = w
        .app
        .get(&format!("/api/cards/{}/comments", new_id()), Some(&w.ada))
        .await;
    assert_eq!(empty.body, json!({ "resolved": false, "comments": [] }));
    let counts = w.app.get("/api/comments/counts", Some(&w.cy)).await.body;
    assert_eq!(
        counts,
        json!({ card.clone(): { "open": 2, "resolved": false } })
    );

    // Only its author edits it.
    let path = format!("/api/comments/{}", first["id"].as_str().unwrap());
    for who in [&w.ada, &w.cy] {
        let res = w
            .app
            .write(
                Method::PATCH,
                &path,
                Some(who),
                json!({ "text": "Changed" }),
            )
            .await;
        assert_eq!(res.status, StatusCode::FORBIDDEN);
    }
    w.app.clock.advance(5);
    let res = w
        .app
        .write(
            Method::PATCH,
            &path,
            Some(&w.bo),
            json!({ "text": "Changed" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body["text"], "Changed");
    assert_eq!(res.body["edited_at"], START + 15);
    // Without `mentions` they stay.
    assert_eq!(res.body["mentions"], json!([w.ada_id]));

    // Any Member resolves and reopens.
    let resolved = format!("/api/cards/{card}/comments/resolved");
    let res = w
        .app
        .put(&resolved, Some(&w.cy), json!({ "resolved": true }))
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body, json!({ "resolved": true }));
    let counts = w.app.get("/api/comments/counts", Some(&w.cy)).await.body;
    assert_eq!(counts[&card], json!({ "open": 2, "resolved": true }));
    let thread = w
        .app
        .get(&format!("/api/cards/{card}/comments"), Some(&w.bo))
        .await;
    assert_eq!(thread.body["resolved"], true);
    let res = w
        .app
        .put(&resolved, Some(&w.bo), json!({ "resolved": false }))
        .await;
    assert_eq!(res.body, json!({ "resolved": false }));
    let res = w
        .app
        .put(
            &format!("/api/cards/{}/comments/resolved", new_id()),
            Some(&w.bo),
            json!({ "resolved": true }),
        )
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);

    // Its author or an Admin deletes it; nobody else.
    let res = w.app.delete(&path, Some(&w.cy)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    let res = w.app.delete(&path, Some(&w.ada)).await;
    assert_eq!(res.status, StatusCode::OK);
    let res = w.app.delete(&path, Some(&w.ada)).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    let second_path = format!("/api/comments/{}", second["id"].as_str().unwrap());
    let res = w.app.delete(&second_path, Some(&w.cy)).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(
        w.app.get("/api/comments/counts", Some(&w.cy)).await.body,
        json!({})
    );
    // Unknown and malformed ids.
    for bad in [
        "/api/comments/nope".to_string(),
        format!("/api/comments/{}", new_id()),
    ] {
        let res = w
            .app
            .write(Method::PATCH, &bad, Some(&w.bo), json!({ "text": "x" }))
            .await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "{bad}");
    }
}

#[tokio::test]
async fn text_and_mentions_have_their_limits() {
    let w = world().await;
    let card = new_id();
    let at_most = "é".repeat(10_000);
    let res = comment(&w, &w.bo, &card, &at_most, json!([])).await;
    assert_eq!(res.status, StatusCode::CREATED);
    let multi = comment(&w, &w.bo, &card, "line one\nline two\ttab", json!([])).await;
    assert_eq!(multi.status, StatusCode::CREATED);
    for (text, mentions, what) in [
        ("é".repeat(10_001), json!([]), "too long"),
        ("   ".to_string(), json!([]), "empty"),
        ("bell\u{7}".to_string(), json!([]), "a control character"),
        ("x".to_string(), json!([w.guest_id]), "a Guest"),
        ("x".to_string(), json!([new_id()]), "nobody"),
        ("x".to_string(), json!(["not an id"]), "not an id"),
    ] {
        let res = comment(&w, &w.bo, &card, &text, mentions).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{what}");
        assert_eq!(res.code(), "bad_request");
    }
    let path = format!("/api/comments/{}", multi.body["id"].as_str().unwrap());
    let res = w
        .app
        .write(
            Method::PATCH,
            &path,
            Some(&w.bo),
            json!({ "text": "x", "mentions": [w.guest_id] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    let res = w
        .app
        .write(Method::PATCH, &path, Some(&w.bo), json!({ "text": "" }))
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    // A card path that is not an id.
    let res = w
        .app
        .post(
            "/api/cards/nope/comments",
            Some(&w.bo),
            json!({ "text": "x" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn guests_get_403_everywhere() {
    let w = world().await;
    let card = new_id();
    let c = comment(&w, &w.bo, &card, "x", json!([])).await.body;
    let id = c["id"].as_str().unwrap();
    let gets = [
        format!("/api/cards/{card}/comments"),
        "/api/comments/counts".to_string(),
        "/api/for-you".to_string(),
    ];
    for path in gets {
        let res = w.app.get(&path, Some(&w.guest)).await;
        assert_eq!(res.status, StatusCode::FORBIDDEN, "{path}");
        assert_eq!(
            w.app.get(&path, None).await.status,
            StatusCode::UNAUTHORIZED
        );
    }
    let writes = [
        (
            Method::POST,
            format!("/api/cards/{card}/comments"),
            json!({ "text": "x" }),
        ),
        (
            Method::PATCH,
            format!("/api/comments/{id}"),
            json!({ "text": "x" }),
        ),
        (Method::DELETE, format!("/api/comments/{id}"), Value::Null),
        (
            Method::PUT,
            format!("/api/cards/{card}/comments/resolved"),
            json!({ "resolved": true }),
        ),
        (
            Method::POST,
            "/api/for-you/seen".to_string(),
            json!({ "up_to": id }),
        ),
    ];
    for (method, path, body) in writes {
        let res = w
            .app
            .write(method.clone(), &path, Some(&w.guest), body)
            .await;
        assert_eq!(res.status, StatusCode::FORBIDDEN, "{method} {path}");
    }
}

#[tokio::test]
async fn for_you_lists_mentions_newest_first_keeps_200_and_marks_them_seen() {
    for w in [world().await, sqlite_world().await] {
        for_you_lists_mentions_newest_first_keeps_200_and_marks_them_seen_on(w).await;
    }
}

async fn for_you_lists_mentions_newest_first_keeps_200_and_marks_them_seen_on(w: World) {
    let card = new_id();
    // Mentioning oneself tells nobody.
    comment(&w, &w.ada, &card, "note", json!([w.ada_id])).await;
    let mut ids = Vec::new();
    for i in 0..205 {
        w.app.clock.advance(1);
        let res = comment(&w, &w.bo, &card, &format!("n{i}"), json!([w.ada_id])).await;
        ids.push(res.body["id"].as_str().unwrap().to_string());
    }
    let list = w.app.get("/api/for-you", Some(&w.ada)).await.body;
    let items = list["items"].as_array().unwrap();
    assert_eq!(items.len(), 200);
    assert_eq!(items[0]["comment"], ids[204]);
    assert_eq!(items[199]["comment"], ids[5]);
    assert_eq!(
        items[0],
        json!({ "comment": ids[204], "card": card, "author": w.bo_id, "at": START + 205, "seen": false, "snippet": "n204" })
    );
    assert!(
        w.app.get("/api/for-you", Some(&w.cy)).await.body["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    // Seen: that one and every older one.
    let res = w
        .app
        .post(
            "/api/for-you/seen",
            Some(&w.ada),
            json!({ "up_to": ids[100] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body, json!({ "count": 104 }));
    let list = w.app.get("/api/for-you", Some(&w.ada)).await.body;
    let seen: Vec<bool> = list["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["seen"].as_bool().unwrap())
        .collect();
    assert!(seen[..104].iter().all(|s| !s) && seen[104..].iter().all(|s| *s));
    // Not in the caller's list: 404.
    for up_to in [ids[0].clone(), new_id()] {
        let res = w
            .app
            .post("/api/for-you/seen", Some(&w.ada), json!({ "up_to": up_to }))
            .await;
        assert_eq!(res.status, StatusCode::NOT_FOUND);
    }
    let res = w
        .app
        .post(
            "/api/for-you/seen",
            Some(&w.cy),
            json!({ "up_to": ids[204] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn an_edit_tells_only_the_newly_mentioned() {
    for w in [world().await, sqlite_world().await] {
        an_edit_tells_only_the_newly_mentioned_on(w).await;
    }
}

async fn an_edit_tells_only_the_newly_mentioned_on(w: World) {
    let card = new_id();
    let c = comment(&w, &w.bo, &card, "@Ada", json!([w.ada_id]))
        .await
        .body;
    let path = format!("/api/comments/{}", c["id"].as_str().unwrap());
    w.app
        .post(
            "/api/for-you/seen",
            Some(&w.ada),
            json!({ "up_to": c["id"] }),
        )
        .await;
    w.app.clock.advance(100);
    let res = w
        .app
        .write(
            Method::PATCH,
            &path,
            Some(&w.bo),
            json!({ "text": "@Ada @Cy @Bo", "mentions": [w.ada_id, w.cy_id, w.bo_id] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    let ada = w.app.get("/api/for-you", Some(&w.ada)).await.body;
    assert_eq!(ada["items"].as_array().unwrap().len(), 1);
    assert_eq!(ada["items"][0]["seen"], true, "Ada was told before");
    assert_eq!(ada["items"][0]["at"], START);
    let cy = w.app.get("/api/for-you", Some(&w.cy)).await.body;
    assert_eq!(cy["items"][0]["seen"], false);
    assert_eq!(cy["items"][0]["at"], START + 100);
    let bo = w.app.get("/api/for-you", Some(&w.bo)).await.body;
    assert!(bo["items"].as_array().unwrap().is_empty());
    // Deleting it takes it out of every list.
    w.app.delete(&path, Some(&w.bo)).await;
    for who in [&w.ada, &w.cy] {
        let list = w.app.get("/api/for-you", Some(who)).await.body;
        assert!(list["items"].as_array().unwrap().is_empty());
    }
}

#[tokio::test]
async fn a_for_you_entry_shows_the_first_line_of_the_comment_as_it_reads_now() {
    for w in [world().await, sqlite_world().await] {
        a_for_you_entry_shows_the_first_line_of_the_comment_as_it_reads_now_on(w).await;
    }
}

async fn a_for_you_entry_shows_the_first_line_of_the_comment_as_it_reads_now_on(w: World) {
    // A Card on no Branch (removed, or never there): its thread is still the Members' to read.
    let card = new_id();
    let long = format!(
        "**@Ada** look at [this](https://example.org) {}\nsecond line",
        "x ".repeat(200)
    );
    let c = comment(&w, &w.bo, &card, &long, json!([w.ada_id]))
        .await
        .body;
    let list = w.app.get("/api/for-you", Some(&w.ada)).await.body;
    let snippet = list["items"][0]["snippet"].as_str().unwrap().to_string();
    assert!(snippet.starts_with("@Ada look at this x x"), "{snippet}");
    assert!(
        snippet.ends_with('…') && snippet.chars().count() <= 140,
        "{snippet}"
    );
    assert!(!snippet.contains("second") && !snippet.contains("example.org"));

    // An edit shows its new text.
    let path = format!("/api/comments/{}", c["id"].as_str().unwrap());
    let res = w
        .app
        .write(
            Method::PATCH,
            &path,
            Some(&w.bo),
            json!({ "text": "  \n`Changed` my mind  " }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let list = w.app.get("/api/for-you", Some(&w.ada)).await.body;
    assert_eq!(list["items"][0]["snippet"], "Changed my mind");

    // A Guest has no For you list at all.
    let res = w.app.get("/api/for-you", Some(&w.guest)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
}

// ---------------------------------------------------------------- live

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(addr: std::net::SocketAddr, cookie: &str) -> Socket {
    let mut req = format!("ws://{addr}/api/ws").into_client_request().unwrap();
    req.headers_mut()
        .insert("cookie", HeaderValue::from_str(cookie).unwrap());
    req.headers_mut()
        .insert("origin", HeaderValue::from_static(ORIGIN));
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    // A frame back means the connection's task runs and receives broadcasts.
    ws.send(Message::Text("ping?".into())).await.unwrap();
    assert_eq!(next(&mut ws).await.unwrap()["type"], "error");
    ws
}

/// The next frame within a short while, if any.
async fn next(ws: &mut Socket) -> Option<Value> {
    loop {
        match tokio::time::timeout(Duration::from_millis(500), ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => return Some(serde_json::from_str(&t).unwrap()),
            Ok(Some(Ok(_))) => continue,
            _ => return None,
        }
    }
}

#[tokio::test]
async fn members_hear_of_threads_and_the_mentioned_of_their_count_and_guests_of_nothing() {
    let w = world().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = w.app.router.clone();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let mut ada = connect(addr, &w.ada).await;
    let mut cy = connect(addr, &w.cy).await;
    let mut guest = connect(addr, &w.guest).await;

    let card = new_id();
    let c = comment(&w, &w.bo, &card, "@Ada", json!([w.ada_id]))
        .await
        .body;
    assert_eq!(
        next(&mut ada).await,
        Some(json!({ "type": "comments", "card": card }))
    );
    assert_eq!(
        next(&mut ada).await,
        Some(json!({ "type": "for_you", "count": 1 }))
    );
    assert_eq!(
        next(&mut cy).await,
        Some(json!({ "type": "comments", "card": card }))
    );
    assert_eq!(next(&mut cy).await, None, "Cy was not mentioned");
    assert_eq!(next(&mut guest).await, None);

    w.app
        .put(
            &format!("/api/cards/{card}/comments/resolved"),
            Some(&w.cy),
            json!({ "resolved": true }),
        )
        .await;
    assert_eq!(
        next(&mut ada).await,
        Some(json!({ "type": "comments", "card": card }))
    );
    w.app
        .post(
            "/api/for-you/seen",
            Some(&w.ada),
            json!({ "up_to": c["id"] }),
        )
        .await;
    assert_eq!(
        next(&mut ada).await,
        Some(json!({ "type": "for_you", "count": 0 }))
    );
    assert_eq!(
        next(&mut cy).await,
        Some(json!({ "type": "comments", "card": card }))
    );
    assert_eq!(next(&mut cy).await, None);
    assert_eq!(next(&mut guest).await, None);
}

// ---------------------------------------------------------------- Local

#[tokio::test]
async fn comments_work_in_a_local_workspace_as_notes_to_oneself() {
    let web = web_dir();
    let mut config = local_config(([127, 0, 0, 1], 4321).into(), web.path().to_path_buf());
    config.dev_origin = Some(ORIGIN.to_string());
    let store = Arc::new(MemoryStore::new());
    let clock = infall_server::Clock::manual(START);
    let built =
        build_local_app(config, store.clone(), clock.clone(), Preset::Blank, "Ada").unwrap();
    let app = TestApp {
        router: built.router,
        clock,
        store,
        web,
    };
    let res = app
        .get(&format!("/api/local/enter?key={}", built.entry_key), None)
        .await;
    let c = res.cookie();
    let card = new_id();
    let res = app
        .post(
            &format!("/api/cards/{card}/comments"),
            Some(&c),
            json!({ "text": "Remember this" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.text);
    let thread = app
        .get(&format!("/api/cards/{card}/comments"), Some(&c))
        .await
        .body;
    assert_eq!(thread["comments"][0]["text"], "Remember this");
    assert_eq!(
        app.get("/api/comments/counts", Some(&c)).await.body[&card]["open"],
        1
    );
}
