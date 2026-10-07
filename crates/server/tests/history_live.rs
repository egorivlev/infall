mod common;

use std::net::SocketAddr;
use std::time::Duration;

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

/// Asserts nothing arrives for a short while.
async fn quiet(ws: &mut Socket) {
    if let Ok(Some(Ok(Message::Text(t)))) =
        tokio::time::timeout(Duration::from_millis(200), ws.next()).await
    {
        panic!("unexpected frame {t}");
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

/// A connection subscribed to `branch` at its head, with the first frames consumed.
async fn subscribed(addr: SocketAddr, cookie: &str, branch: &str) -> Socket {
    let mut ws = connected(addr, cookie).await;
    let msg = json!({ "type": "subscribe", "branch": branch, "after": u32::MAX }).to_string();
    ws.send(Message::Text(msg.into())).await.unwrap();
    assert_eq!(next_frame(&mut ws).await["type"], "subscribed");
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

/// Reads frames until one that is not `presence` (other sockets joining cause those).
async fn next_news(ws: &mut Socket) -> Value {
    loop {
        let frame = next_frame(ws).await;
        if frame["type"] != "presence" {
            return frame;
        }
    }
}

/// Asserts that only `presence` frames, if anything, arrive for a short while.
async fn no_news(ws: &mut Socket) {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(200);
    while let Ok(Some(Ok(msg))) = tokio::time::timeout_at(deadline, ws.next()).await {
        if let Message::Text(t) = msg {
            let frame: Value = serde_json::from_str(&t).unwrap();
            assert_eq!(frame["type"], "presence", "unexpected frame {t}");
        }
    }
}

struct World {
    app: TestApp,
    admin: String,
    bea: String,
    guest: String,
    main: String,
    side: String,
    card: String,
}

/// An Admin, a Member and a Guest; main has two Changes and a Branch `side` forked at 1.
async fn world() -> World {
    let app = TestApp::new();
    let admin = app.admin().await;
    let bea = app.join(&admin, "bea@example.org", "member", None).await;
    let guest = app
        .join(&admin, "g@example.org", "guest", Some(START + 1_000_000))
        .await;
    let main = app.main_branch(&admin).await;
    let card = new_id();
    let res = app
        .post(
            &format!("/api/branches/{main}/ops"),
            Some(&admin),
            json!({ "ops": [create_card(&card, "A"), set_title(&card, "A2")] }),
        )
        .await;
    assert_eq!(res.status.as_u16(), 200, "{}", res.text);
    let res = app
        .post(
            "/api/branches",
            Some(&admin),
            json!({ "name": "side", "from": { "branch": main, "seq": 1 } }),
        )
        .await;
    assert_eq!(res.status.as_u16(), 200, "{}", res.text);
    let side = res.body["branch"]["id"].as_str().unwrap().to_string();
    World {
        app,
        admin,
        bea,
        guest,
        main,
        side,
        card,
    }
}

#[tokio::test]
async fn a_restore_is_broadcast_as_changes_and_a_no_op_restore_is_not() {
    let w = world().await;
    let addr = serve(&w.app).await;
    let mut sender = subscribed(addr, &w.admin, &w.main).await;
    let mut other = subscribed(addr, &w.bea, &w.main).await;
    let mut guest = guest_subscribed(addr, &w.guest, &w.main).await;
    let mut elsewhere = subscribed(addr, &w.bea, &w.side).await;

    let path = format!("/api/branches/{}/restore", w.main);
    let res = w
        .app
        .post(&path, Some(&w.admin), json!({ "to_seq": 1 }))
        .await;
    assert_eq!(res.status.as_u16(), 200, "{}", res.text);
    let n = res.body["changes"].as_array().unwrap().len() as u64;
    assert!(n > 0);
    for ws in [&mut sender, &mut other] {
        let frame = next_news(ws).await;
        assert_eq!(
            frame,
            json!({
                "type": "changes",
                "branch": w.main,
                "seq": 2 + n,
                "changes": res.body["changes"],
            })
        );
        assert_eq!(frame["changes"][0]["origin"]["Restore"]["to_seq"], 1);
    }
    no_news(&mut elsewhere).await;
    // A Guest is only told to read the Board again.
    assert_eq!(
        next_frame(&mut guest).await,
        json!({ "type": "refresh", "branch": w.main, "seq": 2 + n })
    );

    // The Board already matches moment 1: nothing to say.
    let res = w
        .app
        .post(&path, Some(&w.admin), json!({ "to_seq": 1 }))
        .await;
    assert_eq!(res.body, json!({ "seq": 2 + n, "changes": [] }));
    for ws in [&mut sender, &mut other, &mut elsewhere] {
        no_news(ws).await;
    }
    quiet(&mut guest).await;

    // The stream carries on in order afterwards.
    let res = w
        .app
        .post(
            &format!("/api/branches/{}/ops", w.main),
            Some(&w.bea),
            json!({ "ops": [set_title(&w.card, "A3")] }),
        )
        .await;
    assert_eq!(res.body["seq"], 3 + n);
    assert_eq!(next_news(&mut sender).await["seq"], 3 + n);
    assert_eq!(
        next_frame(&mut guest).await,
        json!({ "type": "refresh", "branch": w.main, "seq": 3 + n })
    );
}

#[tokio::test]
async fn a_checkpoint_reaches_that_branchs_member_subscribers_only() {
    let w = world().await;
    let addr = serve(&w.app).await;
    let mut sender = subscribed(addr, &w.admin, &w.main).await;
    let mut other = subscribed(addr, &w.bea, &w.main).await;
    let mut guest = guest_subscribed(addr, &w.guest, &w.main).await;
    let mut elsewhere = subscribed(addr, &w.bea, &w.side).await;
    let mut idle = connected(addr, &w.bea).await;

    let res = w
        .app
        .post(
            &format!("/api/branches/{}/checkpoints", w.main),
            Some(&w.admin),
            json!({ "name": "v1", "seq": 1 }),
        )
        .await;
    assert_eq!(res.status.as_u16(), 200, "{}", res.text);
    for ws in [&mut sender, &mut other] {
        assert_eq!(
            next_news(ws).await,
            json!({
                "type": "checkpoint",
                "branch": w.main,
                "checkpoint": res.body["checkpoint"],
            })
        );
    }
    quiet(&mut guest).await;
    no_news(&mut elsewhere).await;
    quiet(&mut idle).await;

    // A refused Checkpoint is not announced.
    let res = w
        .app
        .post(
            &format!("/api/branches/{}/checkpoints", w.main),
            Some(&w.admin),
            json!({ "name": "v1" }),
        )
        .await;
    assert_eq!(res.code(), "name_taken");
    no_news(&mut sender).await;

    // One on the other Branch goes to that Branch's subscribers.
    let res = w
        .app
        .post(
            &format!("/api/branches/{}/checkpoints", w.side),
            Some(&w.bea),
            json!({ "name": "v1" }),
        )
        .await;
    assert_eq!(res.status.as_u16(), 200, "{}", res.text);
    let frame = next_news(&mut elsewhere).await;
    assert_eq!(frame["type"], "checkpoint");
    assert_eq!(frame["branch"], w.side.as_str());
    assert_eq!(frame["checkpoint"], res.body["checkpoint"]);
    no_news(&mut sender).await;
    no_news(&mut other).await;
    quiet(&mut guest).await;
}

#[tokio::test]
async fn a_new_branch_is_announced_to_every_member_and_never_to_guests() {
    let w = world().await;
    let addr = serve(&w.app).await;
    let mut on_main = subscribed(addr, &w.admin, &w.main).await;
    let mut on_side = subscribed(addr, &w.bea, &w.side).await;
    let mut idle = connected(addr, &w.bea).await;
    let mut guest = guest_subscribed(addr, &w.guest, &w.main).await;
    let mut idle_guest = connected(addr, &w.guest).await;

    let res = w
        .app
        .post(
            "/api/branches",
            Some(&w.bea),
            json!({ "name": "third", "from": { "branch": w.side, "seq": 0 } }),
        )
        .await;
    assert_eq!(res.status.as_u16(), 200, "{}", res.text);
    let listed = w.app.get("/api/branches", Some(&w.admin)).await.body;
    assert_eq!(listed["branches"].as_array().unwrap().len(), 3);
    for ws in [&mut on_main, &mut on_side, &mut idle] {
        let frame = next_news(ws).await;
        assert_eq!(
            frame,
            json!({ "type": "branches", "branches": listed["branches"] })
        );
        assert!(
            frame["branches"]
                .as_array()
                .unwrap()
                .contains(&res.body["branch"])
        );
    }
    quiet(&mut guest).await;
    quiet(&mut idle_guest).await;

    // A refused fork is not announced.
    let res = w
        .app
        .post(
            "/api/branches",
            Some(&w.bea),
            json!({ "name": "third", "from": { "branch": w.main, "seq": 0 } }),
        )
        .await;
    assert_eq!(res.code(), "name_taken");
    no_news(&mut on_main).await;
    quiet(&mut idle).await;
}
