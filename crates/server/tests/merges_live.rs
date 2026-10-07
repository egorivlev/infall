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

async fn ops(app: &TestApp, cookie: &str, branch: &str, ops: Value) {
    let res = app
        .post(
            &format!("/api/branches/{branch}/ops"),
            Some(cookie),
            json!({ "ops": ops }),
        )
        .await;
    assert_eq!(res.status.as_u16(), 200, "{}", res.text);
}

/// An Admin, a Member and a Guest; main has one Card and a Branch `side` forked at 1,
/// where the Card was then retitled.
async fn world() -> World {
    let app = TestApp::new();
    let admin = app.admin().await;
    let bea = app.join(&admin, "bea@example.org", "member", None).await;
    let guest = app
        .join(&admin, "g@example.org", "guest", Some(START + 1_000_000))
        .await;
    let main = app.main_branch(&admin).await;
    let card = new_id();
    ops(&app, &admin, &main, json!([create_card(&card, "A")])).await;
    let res = app
        .post(
            "/api/branches",
            Some(&admin),
            json!({ "name": "side", "from": { "branch": main, "seq": 1 } }),
        )
        .await;
    assert_eq!(res.status.as_u16(), 200, "{}", res.text);
    let side = res.body["branch"]["id"].as_str().unwrap().to_string();
    ops(&app, &admin, &side, json!([set_title(&card, "A-side")])).await;
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

impl World {
    async fn planned(&self, source: &str, target: &str) -> Value {
        let res = self
            .app
            .get(
                &format!("/api/merges/plan?source={source}&target={target}"),
                Some(&self.admin),
            )
            .await;
        assert_eq!(res.status.as_u16(), 200, "{}", res.text);
        res.body["plan"].clone()
    }

    async fn branches(&self) -> Value {
        self.app.get("/api/branches", Some(&self.admin)).await.body["branches"].clone()
    }
}

#[tokio::test]
async fn a_merge_into_main_reaches_its_subscribers_guests_included() {
    let w = world().await;
    let addr = serve(&w.app).await;
    let mut sender = subscribed(addr, &w.admin, &w.main).await;
    let mut other = subscribed(addr, &w.bea, &w.main).await;
    let mut guest = subscribed(addr, &w.guest, &w.main).await;
    let mut on_source = subscribed(addr, &w.bea, &w.side).await;
    let mut idle = connected(addr, &w.bea).await;
    let mut idle_guest = connected(addr, &w.guest).await;

    // Planning says nothing to anyone.
    let plan = w.planned(&w.side, &w.main).await;
    for ws in [&mut sender, &mut other, &mut guest, &mut on_source] {
        no_news(ws).await;
    }

    let res = w
        .app
        .post(
            "/api/merges",
            Some(&w.admin),
            json!({ "plan": plan, "decisions": [], "checkpoint": "before side" }),
        )
        .await;
    assert_eq!(res.status.as_u16(), 200, "{}", res.text);
    assert_eq!(res.body["seq"], 2);
    let changes = json!({
        "type": "changes",
        "branch": w.main,
        "seq": 2,
        "changes": res.body["changes"],
    });
    assert_eq!(changes["changes"][0]["op"], set_title(&w.card, "A-side"));
    assert!(changes["changes"][0]["origin"]["Merge"].is_object());
    let branches = json!({ "type": "branches", "branches": w.branches().await });
    assert_eq!(
        branches["branches"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["id"] == w.main.as_str())
            .unwrap()["seq"],
        2
    );

    // The target's Members: the Changes, then the Checkpoint, then the Branch list.
    for ws in [&mut sender, &mut other] {
        assert_eq!(next_news(ws).await, changes);
        assert_eq!(
            next_news(ws).await,
            json!({
                "type": "checkpoint",
                "branch": w.main,
                "checkpoint": res.body["checkpoint"],
            })
        );
        assert_eq!(next_news(ws).await, branches);
        no_news(ws).await;
    }
    // A Guest on main sees the Changes and nothing else.
    assert_eq!(next_news(&mut guest).await, changes);
    no_news(&mut guest).await;
    // The source's subscribers and idle Members only learn the new heads.
    assert_eq!(next_news(&mut on_source).await, branches);
    no_news(&mut on_source).await;
    assert_eq!(next_frame(&mut idle).await, branches);
    quiet(&mut idle).await;
    quiet(&mut idle_guest).await;

    // The stream on main carries on in order afterwards.
    ops(&w.app, &w.bea, &w.main, json!([set_title(&w.card, "A3")])).await;
    for ws in [&mut sender, &mut guest] {
        let frame = next_news(ws).await;
        assert_eq!(frame["type"], "changes");
        assert_eq!(frame["seq"], 3);
    }
}

#[tokio::test]
async fn a_merge_into_a_branch_reaches_that_branch_and_not_the_source() {
    let w = world().await;
    ops(
        &w.app,
        &w.admin,
        &w.main,
        json!([create_card(&new_id(), "B")]),
    )
    .await;
    let addr = serve(&w.app).await;
    let mut on_target = subscribed(addr, &w.bea, &w.side).await;
    let mut on_source = subscribed(addr, &w.admin, &w.main).await;
    let mut guest = subscribed(addr, &w.guest, &w.main).await;

    let plan = w.planned(&w.main, &w.side).await;
    let res = w
        .app
        .post(
            "/api/merges",
            Some(&w.admin),
            json!({ "plan": plan, "decisions": [] }),
        )
        .await;
    assert_eq!(res.status.as_u16(), 200, "{}", res.text);
    assert_eq!(
        next_news(&mut on_target).await,
        json!({
            "type": "changes",
            "branch": w.side,
            "seq": res.body["seq"],
            "changes": res.body["changes"],
        })
    );
    let branches = json!({ "type": "branches", "branches": w.branches().await });
    // No Checkpoint was asked for: the Branch list is next.
    assert_eq!(next_news(&mut on_target).await, branches);
    no_news(&mut on_target).await;
    assert_eq!(next_news(&mut on_source).await, branches);
    no_news(&mut on_source).await;
    no_news(&mut guest).await;
}

#[tokio::test]
async fn a_merge_that_changes_nothing_sends_no_changes_and_a_refused_one_sends_nothing() {
    let w = world().await;
    let addr = serve(&w.app).await;
    let mut on_main = subscribed(addr, &w.bea, &w.main).await;
    let mut on_side = subscribed(addr, &w.bea, &w.side).await;
    let mut guest = subscribed(addr, &w.guest, &w.main).await;

    // Refused: stale, undecided-free but tampered, and a taken name.
    let plan = w.planned(&w.side, &w.main).await;
    let mut tampered = plan.clone();
    tampered["auto"] = json!([]);
    let res = w
        .app
        .post(
            "/api/merges",
            Some(&w.admin),
            json!({ "plan": tampered, "decisions": [] }),
        )
        .await;
    assert_eq!(res.code(), "stale");
    for ws in [&mut on_main, &mut on_side, &mut guest] {
        no_news(ws).await;
    }

    // main has nothing side lacks: merging it into side appends nothing.
    let plan = w.planned(&w.main, &w.side).await;
    assert_eq!(plan["auto"], json!([]));
    let res = w
        .app
        .post(
            "/api/merges",
            Some(&w.admin),
            json!({ "plan": plan, "decisions": [], "checkpoint": "in sync" }),
        )
        .await;
    assert_eq!(res.status.as_u16(), 200, "{}", res.text);
    assert_eq!(res.body["changes"], json!([]));
    let branches = json!({ "type": "branches", "branches": w.branches().await });
    assert_eq!(
        next_news(&mut on_side).await,
        json!({
            "type": "checkpoint",
            "branch": w.side,
            "checkpoint": res.body["checkpoint"],
        })
    );
    assert_eq!(next_news(&mut on_side).await, branches);
    no_news(&mut on_side).await;
    assert_eq!(next_news(&mut on_main).await, branches);
    no_news(&mut on_main).await;
    no_news(&mut guest).await;
}
