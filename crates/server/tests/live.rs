mod common;

use std::net::SocketAddr;
use std::time::Duration;

use common::*;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
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

async fn connect(
    addr: SocketAddr,
    cookie: Option<&str>,
    origin: Option<&str>,
) -> Result<Socket, WsError> {
    let mut req = format!("ws://{addr}/api/ws").into_client_request().unwrap();
    if let Some(c) = cookie {
        req.headers_mut()
            .insert("cookie", HeaderValue::from_str(c).unwrap());
    }
    if let Some(o) = origin {
        req.headers_mut()
            .insert("origin", HeaderValue::from_str(o).unwrap());
    }
    tokio_tungstenite::connect_async(req).await.map(|(s, _)| s)
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

async fn subscribe(ws: &mut Socket, branch: &str, after: u64) {
    let msg = json!({ "type": "subscribe", "branch": branch, "after": after }).to_string();
    ws.send(Message::Text(msg.into())).await.unwrap();
}

async fn member_id(app: &TestApp, cookie: &str) -> String {
    app.get("/api/me", Some(cookie)).await.body["member"]["id"]
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn subscribe_gets_subscribed_then_catch_up_then_presence() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let me = member_id(&app, &admin).await;
    let main = app.main_branch(&admin).await;
    let a = new_id();
    app.post(
        &format!("/api/branches/{main}/ops"),
        Some(&admin),
        json!({ "ops": [create_card(&a, "A"), set_title(&a, "B")] }),
    )
    .await;
    let addr = serve(&app).await;
    let mut ws = connect(addr, Some(&admin), Some(ORIGIN)).await.unwrap();
    subscribe(&mut ws, &main, 1).await;
    assert_eq!(
        next_frame(&mut ws).await,
        json!({ "type": "subscribed", "branch": main, "seq": 2 })
    );
    let changes = next_frame(&mut ws).await;
    assert_eq!(changes["type"], "changes");
    assert_eq!(changes["seq"], 2);
    assert_eq!(changes["changes"].as_array().unwrap().len(), 1);
    assert_eq!(changes["changes"][0]["op"], set_title(&a, "B"));
    assert_eq!(
        next_frame(&mut ws).await,
        json!({ "type": "presence", "branch": main, "members": [me] })
    );
    assert_eq!(
        next_frame(&mut ws).await,
        json!({ "type": "editing", "branch": main, "editors": [] })
    );

    // Already up to date: no changes frame.
    let mut ws2 = connect(addr, Some(&admin), Some(ORIGIN)).await.unwrap();
    subscribe(&mut ws2, &main, 2).await;
    assert_eq!(next_frame(&mut ws2).await["type"], "subscribed");
    let presence = next_frame(&mut ws2).await;
    assert_eq!(presence["type"], "presence");
    assert_eq!(
        presence["members"],
        json!([me]),
        "a Member connected twice appears once"
    );
    assert_eq!(next_frame(&mut ws2).await["type"], "editing");
    quiet(&mut ws).await;
}

#[tokio::test]
async fn a_post_reaches_every_subscriber_with_the_right_seq() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let bea = app.join(&admin, "bea@example.org", "member", None).await;
    let main = app.main_branch(&admin).await;
    let addr = serve(&app).await;

    let mut first = connect(addr, Some(&admin), Some(ORIGIN)).await.unwrap();
    subscribe(&mut first, &main, 0).await;
    assert_eq!(next_frame(&mut first).await["type"], "subscribed");
    assert_eq!(next_frame(&mut first).await["type"], "presence");
    assert_eq!(next_frame(&mut first).await["type"], "editing");

    let mut second = connect(addr, Some(&bea), Some(ORIGIN)).await.unwrap();
    subscribe(&mut second, &main, 0).await;
    assert_eq!(next_frame(&mut second).await["type"], "subscribed");
    assert_eq!(next_frame(&mut second).await["type"], "presence");
    assert_eq!(next_frame(&mut second).await["type"], "editing");
    let presence = next_frame(&mut first).await;
    assert_eq!(presence["members"].as_array().unwrap().len(), 2);

    let bea_id = member_id(&app, &bea).await;
    let a = new_id();
    let res = app
        .post(
            &format!("/api/branches/{main}/ops"),
            Some(&bea),
            json!({ "ops": [create_card(&a, "A")] }),
        )
        .await;
    assert_eq!(res.body["seq"], 1);
    for ws in [&mut first, &mut second] {
        let frame = next_frame(ws).await;
        assert_eq!(frame["type"], "changes");
        assert_eq!(frame["branch"], main.as_str());
        assert_eq!(frame["seq"], 1);
        assert_eq!(frame["changes"][0]["author"], bea_id.as_str());
        assert_eq!(frame["changes"], res.body["changes"]);
    }
    let res = app
        .post(
            &format!("/api/branches/{main}/ops"),
            Some(&admin),
            json!({ "ops": [set_title(&a, "B"), set_title(&a, "C")] }),
        )
        .await;
    let frame = next_frame(&mut first).await;
    assert_eq!(frame["seq"], 3);
    assert_eq!(frame["changes"].as_array().unwrap().len(), 2);
    assert_eq!(frame["changes"], res.body["changes"]);
}

#[tokio::test]
async fn presence_updates_when_a_client_disconnects() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let bea = app.join(&admin, "bea@example.org", "member", None).await;
    let admin_id = member_id(&app, &admin).await;
    let main = app.main_branch(&admin).await;
    let addr = serve(&app).await;

    let mut first = connect(addr, Some(&admin), Some(ORIGIN)).await.unwrap();
    subscribe(&mut first, &main, 0).await;
    next_frame(&mut first).await;
    next_frame(&mut first).await;
    next_frame(&mut first).await;
    let mut second = connect(addr, Some(&bea), Some(ORIGIN)).await.unwrap();
    subscribe(&mut second, &main, 0).await;
    next_frame(&mut second).await;
    next_frame(&mut second).await;
    next_frame(&mut second).await;
    assert_eq!(
        next_frame(&mut first).await["members"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    second.close(None).await.unwrap();
    drop(second);
    let presence = next_frame(&mut first).await;
    assert_eq!(
        presence,
        json!({ "type": "presence", "branch": main, "members": [admin_id] })
    );
}

#[tokio::test]
async fn the_upgrade_needs_a_session_and_an_allowed_origin() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let addr = serve(&app).await;
    let status = |r: Result<Socket, WsError>| match r {
        Err(WsError::Http(res)) => res.status().as_u16(),
        Err(e) => panic!("unexpected error {e}"),
        Ok(_) => 101,
    };
    assert_eq!(status(connect(addr, None, Some(ORIGIN)).await), 401);
    assert_eq!(
        status(connect(addr, Some("infall_session=forged"), Some(ORIGIN)).await),
        401
    );
    assert_eq!(
        status(connect(addr, Some(&admin), Some("https://evil.example")).await),
        403
    );
    assert_eq!(status(connect(addr, Some(&admin), None).await), 403);
    assert_eq!(status(connect(addr, Some(&admin), Some(ORIGIN)).await), 101);
}

#[tokio::test]
async fn guests_may_subscribe_only_to_main() {
    let (mut ws_state, main_id) = infall_core::Workspace::new();
    let side = ws_state
        .fork(
            "side",
            infall_core::Moment {
                branch: main_id,
                seq: 0,
            },
            infall_core::MemberId::new(),
            1,
        )
        .unwrap();
    let store = infall_server::store::MemoryStore::new();
    infall_server::store::Store::save_workspace(&store, &ws_state).unwrap();
    let app = TestApp::with_store(std::sync::Arc::new(store));
    let admin = app.admin().await;
    let guest = app
        .join(&admin, "g@example.org", "guest", Some(START + 1_000_000))
        .await;
    let addr = serve(&app).await;
    let mut ws = connect(addr, Some(&guest), Some(ORIGIN)).await.unwrap();
    subscribe(&mut ws, &side.0.to_string(), 0).await;
    let frame = next_frame(&mut ws).await;
    assert_eq!(frame["type"], "error");
    assert_eq!(frame["code"], "forbidden");
    subscribe(&mut ws, &main_id.0.to_string(), 0).await;
    assert_eq!(next_frame(&mut ws).await["type"], "subscribed");
}

#[tokio::test]
async fn bad_messages_and_unknown_branches_get_error_frames() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let addr = serve(&app).await;
    let mut ws = connect(addr, Some(&admin), Some(ORIGIN)).await.unwrap();
    ws.send(Message::Text("hello".into())).await.unwrap();
    let frame = next_frame(&mut ws).await;
    assert_eq!(frame["type"], "error");
    assert_eq!(frame["code"], "bad_request");
    subscribe(&mut ws, &new_id(), 0).await;
    assert_eq!(next_frame(&mut ws).await["code"], "not_found");
}

#[tokio::test]
async fn removing_a_member_closes_their_live_connection() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let bea = app.join(&admin, "bea@example.org", "member", None).await;
    let bea_id = member_id(&app, &bea).await;
    let addr = serve(&app).await;
    let mut ws = connect(addr, Some(&bea), Some(ORIGIN)).await.unwrap();
    // Make sure the connection task is running before the removal.
    ws.send(Message::Text("ping?".into())).await.unwrap();
    next_frame(&mut ws).await;
    app.delete(&format!("/api/members/{bea_id}"), Some(&admin))
        .await;
    let closed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match ws.next().await {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert!(closed.is_ok(), "the socket was closed");
}

#[tokio::test]
async fn shutting_down_closes_live_connections() {
    use infall_server::config::Config;
    use infall_server::store::MemoryStore;
    let store: std::sync::Arc<dyn infall_server::store::Store> =
        std::sync::Arc::new(MemoryStore::new());
    let web = web_dir();
    let (router, shutdown) = infall_server::build_app_with(
        Config::for_tests(web.path()),
        store.clone(),
        infall_server::Clock::manual(START),
    )
    .unwrap();
    infall_server::create_admin(&*store, "admin@example.org", "Ada", PASSWORD, START).unwrap();
    let app = TestApp {
        router,
        clock: infall_server::Clock::manual(START),
        store,
        web,
    };
    let cookie = app.login("admin@example.org", PASSWORD).await.cookie();
    let addr = serve(&app).await;
    let mut ws = connect(addr, Some(&cookie), Some(ORIGIN)).await.unwrap();
    ws.send(Message::Text("ping?".into())).await.unwrap();
    next_frame(&mut ws).await;
    shutdown.trigger();
    let closed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match ws.next().await {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert!(closed.is_ok(), "the socket was closed");
}
