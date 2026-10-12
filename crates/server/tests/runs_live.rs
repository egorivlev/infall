//! Live delivery of a Run's result (contract §15): a subscribed Member gets the whole
//! result in the `changes` frame however large it is; a Guest gets a `refresh` and reads it
//! with the Board.

mod common;

use std::net::SocketAddr;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
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

/// The next `changes` frame; who is here and who is editing is skipped.
async fn next_changes(ws: &mut Socket) -> Value {
    loop {
        let frame = next_frame(ws).await;
        match frame["type"].as_str() {
            Some("presence" | "editing") => {}
            Some("changes") => return frame,
            other => panic!("unexpected frame {other:?}"),
        }
    }
}

/// A connection subscribed to `branch`, having said it is at `after`; the `subscribed` frame.
async fn subscribed(addr: SocketAddr, cookie: &str, branch: &str, after: u64) -> (Socket, Value) {
    let mut req = format!("ws://{addr}/api/ws").into_client_request().unwrap();
    req.headers_mut()
        .insert("cookie", HeaderValue::from_str(cookie).unwrap());
    req.headers_mut()
        .insert("origin", HeaderValue::from_static(ORIGIN));
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    let msg = json!({ "type": "subscribe", "branch": branch, "after": after }).to_string();
    ws.send(Message::Text(msg.into())).await.unwrap();
    let frame = next_frame(&mut ws).await;
    assert_eq!(frame["type"], "subscribed");
    (ws, frame)
}

fn text(s: &str) -> Value {
    json!({ "Text": s })
}

/// A PNG, as far as its signature goes, of exactly `chars` base64 characters.
fn png(chars: usize) -> String {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    bytes.resize(chars / 4 * 3, 7);
    STANDARD.encode(bytes)
}

/// The largest result the limits allow, padded to the 600 000 characters of the whole.
fn largest(by: &str) -> String {
    let raw = json!({
        "v": 1, "by": by, "at": START, "code_sha256": "0".repeat(64), "exit": 0,
        "duration_ms": 1, "output": "o\n".repeat(32_000),
        "figures": [{ "png": png(160_000) }, { "png": png(160_000) }, { "png": png(160_000) }]
    })
    .to_string();
    format!("{raw}{}", " ".repeat(600_000 - raw.chars().count()))
}

#[tokio::test]
async fn a_large_result_reaches_a_subscribed_member_whole_and_a_guest_as_a_refresh() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let bea = app.join(&admin, "bea@example.org", "member", None).await;
    let guest = app
        .join(&admin, "g@example.org", "guest", Some(START + 1_000_000))
        .await;
    let main = app.main_branch(&admin).await;
    let ada = app.get("/api/me", Some(&admin)).await.body["member"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let (card, run, other) = (new_id(), new_id(), new_id());
    let run_block = |id: &str| {
        create(
            id,
            "Block",
            json!({ "card": { "Ref": card }, "type": text("run"), "text": text("print(1)"), "order": text("a") }),
        )
    };
    app.ops(
        &admin,
        &main,
        json!([create_card(&card, "A"), run_block(&run), run_block(&other)]),
    )
    .await;
    let addr = serve(&app).await;

    let (mut member, at) = subscribed(addr, &bea, &main, 3).await;
    assert_eq!(at["seq"], 3);
    let (mut watcher, _) = subscribed(addr, &guest, &main, 3).await;

    // Two of the largest results in one batch: a frame of well over a mebibyte.
    let result = largest(&ada);
    let set =
        |id: &str| json!({ "Set": { "entity": id, "field": "result", "value": text(&result) } });
    let res = app
        .ops(&admin, &main, json!([set(&run), set(&other)]))
        .await;
    assert_eq!(res.body["seq"], 5);

    let frame = next_changes(&mut member).await;
    assert_eq!(frame["seq"], 5);
    let changes = frame["changes"].as_array().unwrap();
    assert_eq!(changes.len(), 2);
    for (change, id) in changes.iter().zip([&run, &other]) {
        assert_eq!(change["op"], set(id));
    }
    assert!(frame.to_string().len() > 1024 * 1024);

    // The Guest: one small `refresh`, then the result with the Board.
    assert_eq!(
        next_frame(&mut watcher).await,
        json!({ "type": "refresh", "branch": main, "seq": 5 })
    );
    let board = app
        .get(&format!("/api/branches/{main}/board"), Some(&guest))
        .await;
    assert_eq!(board.status.as_u16(), 200);
    assert_eq!(
        board.body["entities"][&run]["fields"]["result"],
        text(&result)
    );

    // A Member who was away catches up with the same Changes on subscribing.
    let (mut late, _) = subscribed(addr, &bea, &main, 3).await;
    let frame = next_changes(&mut late).await;
    assert_eq!(frame["changes"].as_array().unwrap().len(), 2);
}
