mod common;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;
use common::*;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn serve(app: &TestApp) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = app.router.clone();
    tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    addr
}

async fn next_frame(ws: &mut Socket) -> Value {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("a frame within 5 s")
            .expect("the socket is open")
            .unwrap();
        if let Message::Text(t) = msg {
            return serde_json::from_str(&t).unwrap();
        }
    }
}

/// Reads frames until one that is not `presence`.
async fn next_news(ws: &mut Socket) -> Value {
    loop {
        let frame = next_frame(ws).await;
        if frame["type"] != "presence" {
            return frame;
        }
    }
}

/// Asserts nothing but `presence` arrives for a short while.
async fn quiet(ws: &mut Socket) {
    let until = tokio::time::Instant::now() + Duration::from_millis(200);
    while let Ok(Some(Ok(msg))) = tokio::time::timeout_at(until, ws.next()).await {
        if let Message::Text(t) = msg {
            let frame: Value = serde_json::from_str(&t).unwrap();
            assert_eq!(frame["type"], "presence", "unexpected frame {t}");
        }
    }
}

/// A connection whose server task is known to be running, subscribed to nothing.
async fn connected(addr: SocketAddr, cookie: &str) -> Socket {
    let mut req = format!("ws://{addr}/api/ws").into_client_request().unwrap();
    req.headers_mut()
        .insert("cookie", HeaderValue::from_str(cookie).unwrap());
    req.headers_mut()
        .insert("origin", HeaderValue::from_static(ORIGIN));
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    ws.send(Message::Text("ping?".into())).await.unwrap();
    assert_eq!(next_frame(&mut ws).await["type"], "error");
    ws
}

async fn subscribed(addr: SocketAddr, cookie: &str, branch: &str) -> Socket {
    let mut ws = connected(addr, cookie).await;
    let msg = json!({ "type": "subscribe", "branch": branch, "after": u32::MAX });
    ws.send(Message::Text(msg.to_string().into()))
        .await
        .unwrap();
    assert_eq!(next_news(&mut ws).await["type"], "subscribed");
    assert_eq!(next_frame(&mut ws).await["type"], "presence");
    assert_eq!(next_frame(&mut ws).await["type"], "editing");
    ws
}

/// A Guest's connection subscribed to `branch` at its head: `subscribed` and nothing more.
async fn guest_subscribed(addr: SocketAddr, cookie: &str, branch: &str) -> Socket {
    // The head is learnt on a connection of its own, so that this one is owed no `refresh`.
    let mut probe = connected(addr, cookie).await;
    let msg = json!({ "type": "subscribe", "branch": branch, "after": u32::MAX }).to_string();
    probe.send(Message::Text(msg.into())).await.unwrap();
    let head = next_frame(&mut probe).await["seq"].as_u64().unwrap();
    drop(probe);
    let mut ws = connected(addr, cookie).await;
    let msg = json!({ "type": "subscribe", "branch": branch, "after": head }).to_string();
    ws.send(Message::Text(msg.into())).await.unwrap();
    assert_eq!(
        next_frame(&mut ws).await,
        json!({ "type": "subscribed", "branch": branch, "seq": head })
    );
    ws
}

/// An Admin, two Members and a Guest; `main` with two Cards and `side` forked from it.
struct World {
    app: TestApp,
    addr: SocketAddr,
    main: String,
    side: String,
    admin: String,
    bea: String,
    cal: String,
    guest: String,
    token: String,
    a: String,
    b: String,
}

async fn world() -> World {
    let app = TestApp::with_store(Arc::new(qoop_server::store::MemoryStore::new()));
    let admin = app.admin().await;
    let bea = app.join(&admin, "bea@example.org", "member", None).await;
    let cal = app.join(&admin, "cal@example.org", "member", None).await;
    let guest = app
        .join(
            &admin,
            "gus@example.org",
            "guest",
            Some(START + 100_000_000),
        )
        .await;
    let main = app.main_branch(&admin).await;
    let (a, b) = (new_id(), new_id());
    app.ops(
        &admin,
        &main,
        json!([create_card(&a, "Card A"), create_card(&b, "Card B")]),
    )
    .await;
    let res = app
        .post(
            "/api/branches",
            Some(&admin),
            json!({ "name": "side", "from": { "branch": main, "seq": 2 } }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let side = res.body["branch"]["id"].as_str().unwrap().to_string();
    let token = app.access_token(&admin, "tools").await;
    let addr = serve(&app).await;
    World {
        app,
        addr,
        main,
        side,
        admin,
        bea,
        cal,
        guest,
        token,
        a,
        b,
    }
}

impl World {
    /// The `suggestions` frame a subscriber of `branch` should get now.
    async fn frame(&self, branch: &str) -> Value {
        let res = self
            .app
            .get(
                &format!("/api/suggestions?branch={branch}"),
                Some(&self.admin),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        json!({ "type": "suggestions", "branch": branch, "suggestions": res.body["suggestions"] })
    }
}

#[tokio::test]
async fn every_suggestion_change_goes_to_the_members_subscribed_to_that_branch() {
    let w = world().await;
    let mut bea = subscribed(w.addr, &w.bea, &w.main).await;
    let mut admin = subscribed(w.addr, &w.admin, &w.main).await;
    let mut cal = subscribed(w.addr, &w.cal, &w.side).await;
    let mut guest = guest_subscribed(w.addr, &w.guest, &w.main).await;
    let mut idle = connected(w.addr, &w.bea).await;

    // Proposed through the tool layer.
    let made = w
        .app
        .tool_ok(
            &w.token,
            "suggest_source",
            json!({ "card": w.a, "doi": "10.1/x", "reason": "Relevant." }),
        )
        .await;
    let id = made["id"].as_str().unwrap().to_string();
    let expected = w.frame(&w.main).await;
    assert_eq!(expected["suggestions"].as_array().unwrap().len(), 1);
    assert_eq!(expected["suggestions"][0]["id"], id);
    for ws in [&mut bea, &mut admin] {
        assert_eq!(next_news(ws).await, expected);
    }
    // A duplicate and a refused proposal change nothing, so send nothing.
    w.app
        .tool_ok(
            &w.token,
            "suggest_source",
            json!({ "card": w.a, "doi": "10.1/x", "reason": "Again." }),
        )
        .await;
    w.app
        .tool_err(
            &w.token,
            "suggest_source",
            json!({ "card": w.a, "reason": "No source." }),
        )
        .await;

    // Rejected, then reopened.
    for (action, state) in [("reject", "rejected"), ("reopen", "pending")] {
        let res = w
            .app
            .post(
                &format!("/api/suggestions/{id}/{action}"),
                Some(&w.bea),
                json!({}),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        let expected = w.frame(&w.main).await;
        assert_eq!(expected["suggestions"][0]["state"], state);
        for ws in [&mut bea, &mut admin] {
            assert_eq!(next_news(ws).await, expected);
        }
    }
    // A refused action sends nothing.
    let res = w
        .app
        .post(
            &format!("/api/suggestions/{id}/reopen"),
            Some(&w.bea),
            json!({}),
        )
        .await;
    assert_eq!(res.code(), "already_decided");

    // Accepted: the `changes` frame, then the `suggestions` frame. The Guest is only told
    // to read the Board again.
    let (source, attachment) = (new_id(), new_id());
    let res = w
        .app
        .post(
            &format!("/api/suggestions/{id}/accept"),
            Some(&w.bea),
            json!({ "ops": [
                create(&source, "Source", json!({ "doi": { "Text": "10.1/x" } })),
                create(&attachment, "Attachment", json!({ "card": { "Ref": w.a }, "source": { "Ref": source } })),
            ] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let changes = json!({
        "type": "changes", "branch": w.main, "seq": res.body["seq"], "changes": res.body["changes"]
    });
    assert_eq!(changes["seq"], 4);
    let expected = w.frame(&w.main).await;
    assert_eq!(expected["suggestions"][0], res.body["suggestion"]);
    assert_eq!(expected["suggestions"][0]["state"], "accepted");
    for ws in [&mut bea, &mut admin] {
        assert_eq!(next_news(ws).await, changes);
        assert_eq!(next_news(ws).await, expected);
    }
    assert_eq!(
        next_frame(&mut guest).await,
        json!({ "type": "refresh", "branch": w.main, "seq": 4 })
    );

    // Nobody else heard any of it: not the Member on another Branch, not the Guest on
    // this one, not a connection subscribed to nothing.
    quiet(&mut cal).await;
    quiet(&mut guest).await;
    quiet(&mut idle).await;
    quiet(&mut bea).await;

    // A Suggestion on `side` goes to Cal only.
    w.app
        .tool_ok(
            &w.token,
            "suggest_connection",
            json!({ "branch": "side", "from": w.a, "to": w.b, "reason": "Linked." }),
        )
        .await;
    let expected = w.frame(&w.side).await;
    assert_eq!(expected["suggestions"].as_array().unwrap().len(), 1);
    assert_eq!(next_news(&mut cal).await, expected);
    quiet(&mut bea).await;
    quiet(&mut admin).await;
    quiet(&mut guest).await;

    // After moving to `side`, Bea hears about `side` and no longer about `main`.
    let msg = json!({ "type": "subscribe", "branch": w.side, "after": u32::MAX });
    bea.send(Message::Text(msg.to_string().into()))
        .await
        .unwrap();
    assert_eq!(next_news(&mut bea).await["type"], "subscribed");
    assert_eq!(next_news(&mut bea).await["type"], "editing");
    w.app
        .tool_ok(
            &w.token,
            "suggest_source",
            json!({ "card": w.b, "doi": "10.1/y", "reason": "On main." }),
        )
        .await;
    assert_eq!(next_news(&mut admin).await, w.frame(&w.main).await);
    w.app
        .tool_ok(
            &w.token,
            "suggest_source",
            json!({ "branch": "side", "card": w.b, "doi": "10.1/z", "reason": "On side." }),
        )
        .await;
    let expected = w.frame(&w.side).await;
    assert_eq!(next_news(&mut bea).await, expected);
    assert_eq!(next_news(&mut cal).await, expected);
    quiet(&mut guest).await;
}

#[tokio::test]
async fn a_stale_or_refused_accept_sends_no_frame() {
    let w = world().await;
    let made = w
        .app
        .tool_ok(
            &w.token,
            "suggest_connection",
            json!({ "from": w.a, "to": w.b, "reason": "Linked." }),
        )
        .await;
    let id = made["id"].as_str().unwrap();
    let mut bea = subscribed(w.addr, &w.bea, &w.main).await;

    // Refused by the core.
    let res = w
        .app
        .post(
            &format!("/api/suggestions/{id}/accept"),
            Some(&w.bea),
            json!({ "ops": [create_card(&w.a, "Exists already")] }),
        )
        .await;
    assert_eq!(res.code(), "rejected");
    quiet(&mut bea).await;

    // Stale: one end is deleted (that edit itself is a `changes` frame).
    w.app.ops(&w.admin, &w.main, json!([delete_op(&w.b)])).await;
    assert_eq!(next_news(&mut bea).await["type"], "changes");
    let res = w
        .app
        .post(
            &format!("/api/suggestions/{id}/accept"),
            Some(&w.bea),
            json!({ "ops": [create(&new_id(), "Connection", json!({
                "from": { "Ref": w.a }, "to": { "Ref": w.b }
            }))] }),
        )
        .await;
    assert_eq!(res.code(), "stale");
    quiet(&mut bea).await;
    assert_eq!(w.frame(&w.main).await["suggestions"][0]["state"], "pending");
}
