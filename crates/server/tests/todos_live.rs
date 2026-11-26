mod common;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::http::{Method, StatusCode};
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

/// Reads frames until one that is not `presence` (other sockets coming and going cause
/// those).
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

async fn say(ws: &mut Socket, msg: Value) {
    ws.send(Message::Text(msg.to_string().into()))
        .await
        .unwrap();
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

/// Subscribes and returns the `editing` frame that follows `subscribed` and `presence`.
async fn subscribe(ws: &mut Socket, branch: &str) -> Value {
    say(
        ws,
        json!({ "type": "subscribe", "branch": branch, "after": u32::MAX }),
    )
    .await;
    assert_eq!(next_news(ws).await["type"], "subscribed");
    assert_eq!(next_frame(ws).await["type"], "presence");
    let editing = next_frame(ws).await;
    assert_eq!(editing["type"], "editing");
    assert_eq!(editing["branch"], branch);
    editing
}

async fn subscribed(addr: SocketAddr, cookie: &str, branch: &str) -> Socket {
    let mut ws = connected(addr, cookie).await;
    let editing = subscribe(&mut ws, branch).await;
    assert_eq!(editing["editors"], json!([]));
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

async fn claim(ws: &mut Socket, card: Option<&str>) {
    say(ws, json!({ "type": "editing", "card": card })).await;
}

async fn member_id(app: &TestApp, cookie: &str) -> String {
    app.get("/api/me", Some(cookie)).await.body["member"]["id"]
        .as_str()
        .unwrap()
        .to_string()
}

/// An Admin, two Members and a Guest on a Workspace with `main` and `side`.
struct World {
    app: TestApp,
    addr: SocketAddr,
    main: String,
    side: String,
    admin: String,
    bea: String,
    cal: String,
    guest: String,
    admin_id: String,
    bea_id: String,
    cal_id: String,
}

async fn world() -> World {
    let (mut ws, main) = infall_core::Workspace::new();
    let side = ws
        .fork(
            "side",
            infall_core::Moment {
                branch: main,
                seq: 0,
            },
            infall_core::MemberId::new(),
            1,
        )
        .unwrap();
    let store = infall_server::store::MemoryStore::new();
    infall_server::store::Store::save_workspace(&store, &ws).unwrap();
    let app = TestApp::with_store(Arc::new(store));
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
    let addr = serve(&app).await;
    World {
        addr,
        main: main.0.to_string(),
        side: side.0.to_string(),
        admin_id: member_id(&app, &admin).await,
        bea_id: member_id(&app, &bea).await,
        cal_id: member_id(&app, &cal).await,
        app,
        admin,
        bea,
        cal,
        guest,
    }
}

impl World {
    fn editing(&self, branch: &str, editors: Value) -> Value {
        json!({ "type": "editing", "branch": branch, "editors": editors })
    }
}

// ---------------------------------------------------------------- todos

#[tokio::test]
async fn every_todo_change_sends_the_full_list_to_members_and_never_to_guests() {
    let w = world().await;
    // Not subscribed, subscribed to `main`, subscribed to `side`: all the same for To-dos.
    let mut admin = connected(w.addr, &w.admin).await;
    let mut bea = subscribed(w.addr, &w.bea, &w.main).await;
    let mut cal = subscribed(w.addr, &w.cal, &w.side).await;
    let mut guest = guest_subscribed(w.addr, &w.guest, &w.main).await;
    let mut idle_guest = connected(w.addr, &w.guest).await;

    let list = || async { w.app.get("/api/todos", Some(&w.admin)).await.body["todos"].clone() };

    // Added.
    let res = w
        .app
        .post(
            "/api/todos",
            Some(&w.bea),
            json!({ "owner": w.cal_id, "text": "Look at this" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let id = res.body["todo"]["id"].as_str().unwrap().to_string();
    let expected = json!({ "type": "todos", "todos": [res.body["todo"]] });
    for ws in [&mut admin, &mut bea, &mut cal] {
        assert_eq!(next_news(ws).await, expected);
    }
    assert_eq!(expected["todos"], list().await);

    // Changed.
    let res = w
        .app
        .write(
            Method::PATCH,
            &format!("/api/todos/{id}"),
            Some(&w.cal),
            json!({ "done": true }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let expected = json!({ "type": "todos", "todos": [res.body["todo"]] });
    assert_eq!(expected["todos"][0]["done"], true);
    for ws in [&mut admin, &mut bea, &mut cal] {
        assert_eq!(next_news(ws).await, expected);
    }

    // A second one, so the frame is seen to carry the whole list.
    let res = w
        .app
        .post(
            "/api/todos",
            Some(&w.admin),
            json!({ "owner": w.admin_id, "text": "Mine" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    for ws in [&mut admin, &mut bea, &mut cal] {
        let frame = next_news(ws).await;
        assert_eq!(frame["type"], "todos");
        assert_eq!(frame["todos"], list().await);
        assert_eq!(frame["todos"].as_array().unwrap().len(), 2);
    }

    // Refused or empty changes send nothing.
    let res = w
        .app
        .write(
            Method::PATCH,
            &format!("/api/todos/{id}"),
            Some(&w.admin),
            json!({ "text": "Not mine" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    let res = w
        .app
        .write(
            Method::PATCH,
            &format!("/api/todos/{id}"),
            Some(&w.cal),
            json!({}),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    quiet(&mut admin).await;

    // Deleted.
    let res = w
        .app
        .delete(&format!("/api/todos/{id}"), Some(&w.bea))
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    for ws in [&mut admin, &mut bea, &mut cal] {
        let frame = next_news(ws).await;
        assert_eq!(frame["type"], "todos");
        assert_eq!(frame["todos"], list().await);
        assert_eq!(frame["todos"].as_array().unwrap().len(), 1);
    }

    for ws in [&mut guest, &mut idle_guest, &mut admin, &mut bea, &mut cal] {
        quiet(ws).await;
    }
}

#[tokio::test]
async fn removing_a_member_sends_the_list_without_their_todos() {
    let w = world().await;
    let mut admin = connected(w.addr, &w.admin).await;
    let mut guest = guest_subscribed(w.addr, &w.guest, &w.main).await;
    for (cookie, owner, text) in [
        (&w.bea, &w.bea_id, "Bea's own"),
        (&w.bea, &w.cal_id, "Bea gave Cal this"),
    ] {
        let res = w
            .app
            .post(
                "/api/todos",
                Some(cookie),
                json!({ "owner": owner, "text": text }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        assert_eq!(next_news(&mut admin).await["type"], "todos");
    }
    let res = w
        .app
        .delete(&format!("/api/members/{}", w.bea_id), Some(&w.admin))
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let frame = next_news(&mut admin).await;
    assert_eq!(frame["type"], "todos");
    let todos = frame["todos"].as_array().unwrap();
    assert_eq!(todos.len(), 1);
    assert_eq!(todos[0]["text"], "Bea gave Cal this");

    // Removing someone who owns none sends nothing.
    let res = w
        .app
        .delete(&format!("/api/members/{}", w.cal_id), Some(&w.admin))
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let frame = next_news(&mut admin).await;
    assert_eq!(frame["todos"], json!([]), "Cal owned the last one");
    quiet(&mut admin).await;
    quiet(&mut guest).await;
}

// ---------------------------------------------------------------- editing

#[tokio::test]
async fn a_claim_reaches_every_subscriber_of_that_branch_only() {
    let w = world().await;
    let mut admin = subscribed(w.addr, &w.admin, &w.main).await;
    let mut bea = subscribed(w.addr, &w.bea, &w.main).await;
    let mut guest = guest_subscribed(w.addr, &w.guest, &w.main).await;
    let mut cal = subscribed(w.addr, &w.cal, &w.side).await;
    let mut idle = connected(w.addr, &w.cal).await;

    let card = new_id();
    w.app.clock.advance(1_000);
    claim(&mut admin, Some(&card)).await;
    let held = w.editing(
        &w.main,
        json!([{ "card": card, "member": w.admin_id, "since": START + 1_000 }]),
    );
    // The claimant too; never Guests.
    for ws in [&mut admin, &mut bea] {
        assert_eq!(next_news(ws).await, held);
    }
    quiet(&mut guest).await;
    quiet(&mut cal).await;
    quiet(&mut idle).await;

    // Someone who subscribes later is told straight after `subscribed`.
    let mut late = connected(w.addr, &w.cal).await;
    assert_eq!(subscribe(&mut late, &w.main).await, held);
    // And the other Branch has its own, empty, list.
    assert_eq!(
        subscribe(&mut idle, &w.side).await,
        w.editing(&w.side, json!([]))
    );

    // The same Card id on another Branch is another claim.
    w.app.clock.advance(1_000);
    claim(&mut cal, Some(&card)).await;
    let side_held = w.editing(
        &w.side,
        json!([{ "card": card, "member": w.cal_id, "since": START + 2_000 }]),
    );
    assert_eq!(next_news(&mut cal).await, side_held);
    assert_eq!(next_news(&mut idle).await, side_held);
    for ws in [&mut admin, &mut bea, &mut guest, &mut late] {
        quiet(ws).await;
    }

    // Stopping empties the list.
    claim(&mut admin, None).await;
    for ws in [&mut admin, &mut bea, &mut late] {
        assert_eq!(next_news(ws).await, w.editing(&w.main, json!([])));
    }
    quiet(&mut guest).await;
    // Stopping again changes nothing.
    claim(&mut admin, None).await;
    quiet(&mut bea).await;
    quiet(&mut cal).await;
}

#[tokio::test]
async fn the_second_claimant_waits_and_holds_when_the_first_stops() {
    let w = world().await;
    let mut admin = subscribed(w.addr, &w.admin, &w.main).await;
    let mut bea = subscribed(w.addr, &w.bea, &w.main).await;
    let mut cal = subscribed(w.addr, &w.cal, &w.main).await;
    let card = new_id();

    claim(&mut admin, Some(&card)).await;
    let first = w.editing(
        &w.main,
        json!([{ "card": card, "member": w.admin_id, "since": START }]),
    );
    for ws in [&mut admin, &mut bea, &mut cal] {
        assert_eq!(next_news(ws).await, first);
    }

    // Bea, then Cal, queue up: the holder does not change, so nothing is sent.
    w.app.clock.advance(1_000);
    claim(&mut bea, Some(&card)).await;
    quiet(&mut admin).await;
    claim(&mut cal, Some(&card)).await;
    quiet(&mut admin).await;
    // Claiming what one already holds changes nothing either.
    claim(&mut admin, Some(&card)).await;
    for ws in [&mut admin, &mut bea, &mut cal] {
        quiet(ws).await;
    }

    // The holder stops: Bea, who came first, holds it from now.
    w.app.clock.advance(1_000);
    claim(&mut admin, None).await;
    let second = w.editing(
        &w.main,
        json!([{ "card": card, "member": w.bea_id, "since": START + 2_000 }]),
    );
    for ws in [&mut admin, &mut bea, &mut cal] {
        assert_eq!(next_news(ws).await, second);
    }

    // The Admin claims again and is now behind Cal.
    claim(&mut admin, Some(&card)).await;
    quiet(&mut bea).await;
    w.app.clock.advance(1_000);
    claim(&mut bea, None).await;
    let third = w.editing(
        &w.main,
        json!([{ "card": card, "member": w.cal_id, "since": START + 3_000 }]),
    );
    for ws in [&mut admin, &mut bea, &mut cal] {
        assert_eq!(next_news(ws).await, third);
    }
    // A waiting claimant who gives up changes nothing.
    claim(&mut admin, None).await;
    quiet(&mut cal).await;
    claim(&mut cal, None).await;
    assert_eq!(next_news(&mut bea).await, w.editing(&w.main, json!([])));
}

#[tokio::test]
async fn a_claim_ends_when_the_holder_disconnects() {
    let w = world().await;
    let mut admin = subscribed(w.addr, &w.admin, &w.main).await;
    let mut bea = subscribed(w.addr, &w.bea, &w.main).await;
    let mut cal = subscribed(w.addr, &w.cal, &w.main).await;
    let card = new_id();
    claim(&mut admin, Some(&card)).await;
    assert_eq!(
        next_news(&mut bea).await["editors"][0]["member"],
        w.admin_id.as_str()
    );
    assert_eq!(next_news(&mut cal).await["type"], "editing");
    claim(&mut bea, Some(&card)).await;
    quiet(&mut cal).await;

    w.app.clock.advance(7_000);
    admin.close(None).await.unwrap();
    drop(admin);
    let frame = next_news(&mut cal).await;
    assert_eq!(
        frame,
        w.editing(
            &w.main,
            json!([{ "card": card, "member": w.bea_id, "since": START + 7_000 }])
        )
    );
    assert_eq!(next_news(&mut bea).await, frame);

    // The last holder leaving empties the list.
    bea.close(None).await.unwrap();
    drop(bea);
    assert_eq!(next_news(&mut cal).await, w.editing(&w.main, json!([])));
}

#[tokio::test]
async fn a_claim_ends_when_the_holder_subscribes_to_another_branch() {
    let w = world().await;
    let mut admin = subscribed(w.addr, &w.admin, &w.main).await;
    let mut bea = subscribed(w.addr, &w.bea, &w.main).await;
    let mut guest = guest_subscribed(w.addr, &w.guest, &w.main).await;
    let card = new_id();
    claim(&mut admin, Some(&card)).await;
    let first = w.editing(
        &w.main,
        json!([{ "card": card, "member": w.admin_id, "since": START }]),
    );
    for ws in [&mut admin, &mut bea] {
        assert_eq!(next_news(ws).await, first);
    }
    claim(&mut bea, Some(&card)).await;
    quiet(&mut guest).await;

    // Subscribing to the same Branch again keeps the claim.
    assert_eq!(subscribe(&mut admin, &w.main).await, first);
    quiet(&mut bea).await;

    w.app.clock.advance(4_000);
    assert_eq!(
        subscribe(&mut admin, &w.side).await,
        w.editing(&w.side, json!([]))
    );
    let second = w.editing(
        &w.main,
        json!([{ "card": card, "member": w.bea_id, "since": START + 4_000 }]),
    );
    assert_eq!(next_news(&mut bea).await, second);
    // The one who left hears no more of `main`.
    claim(&mut bea, None).await;
    assert_eq!(next_news(&mut bea).await, w.editing(&w.main, json!([])));
    quiet(&mut admin).await;
    // A Guest heard none of it.
    quiet(&mut guest).await;
}

#[tokio::test]
async fn one_connection_holds_at_most_one_card() {
    let w = world().await;
    let mut admin = subscribed(w.addr, &w.admin, &w.main).await;
    let mut bea = subscribed(w.addr, &w.bea, &w.main).await;
    // A second connection of the same Member is a claimant of its own.
    let mut admin2 = subscribed(w.addr, &w.admin, &w.main).await;
    let mut cards = [new_id(), new_id()];
    cards.sort();
    let [x, y] = cards;

    claim(&mut admin, Some(&x)).await;
    assert_eq!(next_news(&mut bea).await["editors"][0]["card"], x.as_str());
    claim(&mut bea, Some(&x)).await;
    claim(&mut admin2, Some(&y)).await;
    assert_eq!(
        next_news(&mut bea).await,
        w.editing(
            &w.main,
            json!([
                { "card": x, "member": w.admin_id, "since": START },
                { "card": y, "member": w.admin_id, "since": START },
            ])
        )
    );

    // Moving to another Card lets go of the first: one frame, Bea now holds `x`, and the
    // mover waits behind the other connection on `y`.
    w.app.clock.advance(2_000);
    claim(&mut admin, Some(&y)).await;
    assert_eq!(
        next_news(&mut bea).await,
        w.editing(
            &w.main,
            json!([
                { "card": x, "member": w.bea_id, "since": START + 2_000 },
                { "card": y, "member": w.admin_id, "since": START },
            ])
        )
    );
    quiet(&mut bea).await;
    w.app.clock.advance(2_000);
    admin2.close(None).await.unwrap();
    drop(admin2);
    assert_eq!(
        next_news(&mut bea).await,
        w.editing(
            &w.main,
            json!([
                { "card": x, "member": w.bea_id, "since": START + 2_000 },
                { "card": y, "member": w.admin_id, "since": START + 4_000 },
            ])
        )
    );
    quiet(&mut bea).await;
}

#[tokio::test]
async fn claims_from_guests_and_before_subscribing_are_ignored() {
    let w = world().await;
    let mut admin = subscribed(w.addr, &w.admin, &w.main).await;
    let mut guest = guest_subscribed(w.addr, &w.guest, &w.main).await;
    let card = new_id();

    claim(&mut guest, Some(&card)).await;
    // Ignored without a word, even when malformed.
    claim(&mut guest, Some("not-an-id")).await;
    quiet(&mut admin).await;
    quiet(&mut guest).await;

    let mut unsubscribed = connected(w.addr, &w.bea).await;
    claim(&mut unsubscribed, Some(&card)).await;
    quiet(&mut admin).await;
    quiet(&mut unsubscribed).await;
    // It did not count as a claim made early: subscribing shows nobody editing.
    assert_eq!(
        subscribe(&mut unsubscribed, &w.main).await,
        w.editing(&w.main, json!([]))
    );

    // The Card is still free for a Member; a Guest claim does not queue behind it either.
    claim(&mut admin, Some(&card)).await;
    let held = w.editing(
        &w.main,
        json!([{ "card": card, "member": w.admin_id, "since": START }]),
    );
    assert_eq!(next_news(&mut admin).await, held);
    claim(&mut guest, Some(&card)).await;
    // The Guest's claim has been handled before the release below is announced.
    say(&mut guest, json!("ping?")).await;
    assert_eq!(next_frame(&mut guest).await["type"], "error");
    claim(&mut admin, None).await;
    assert_eq!(next_news(&mut admin).await, w.editing(&w.main, json!([])));
    quiet(&mut guest).await;

    // A Member's malformed claim gets an error frame and changes nothing.
    claim(&mut admin, Some("not-an-id")).await;
    let frame = next_news(&mut admin).await;
    assert_eq!(frame["type"], "error");
    assert_eq!(frame["code"], "bad_request");
    say(&mut admin, json!({ "type": "editing" })).await;
    quiet(&mut guest).await;
}
