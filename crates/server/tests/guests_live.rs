//! The WebSocket for a Guest from M6 (contract §13): `subscribed`, then nothing but
//! coalesced `refresh` frames; and Members are not affected by a Guest being there.

mod common;

use std::net::SocketAddr;
use std::time::{Duration, Instant};

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

/// Longer than the coalescing window, so an owed `refresh` would have arrived.
const SETTLED: Duration = Duration::from_millis(800);

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

/// Every frame that arrives within `window`, with when it arrived.
async fn frames_within(ws: &mut Socket, window: Duration) -> Vec<(Instant, Value)> {
    let deadline = tokio::time::Instant::now() + window;
    let mut frames = Vec::new();
    while let Ok(Some(Ok(msg))) = tokio::time::timeout_at(deadline, ws.next()).await {
        if let Message::Text(t) = msg {
            frames.push((Instant::now(), serde_json::from_str(&t).unwrap()));
        }
    }
    frames
}

/// Asserts that nothing at all arrives for longer than the coalescing window.
async fn silent(ws: &mut Socket) {
    let frames = frames_within(ws, SETTLED).await;
    assert!(frames.is_empty(), "unexpected frames {frames:?}");
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

/// A Member's connection subscribed to `branch` at its head; returns its `presence` frame
/// too.
async fn member_subscribed(addr: SocketAddr, cookie: &str, branch: &str) -> (Socket, Value) {
    let mut ws = connected(addr, cookie).await;
    say(
        &mut ws,
        json!({ "type": "subscribe", "branch": branch, "after": u32::MAX }),
    )
    .await;
    assert_eq!(next_frame(&mut ws).await["type"], "subscribed");
    let presence = next_frame(&mut ws).await;
    assert_eq!(presence["type"], "presence");
    assert_eq!(next_frame(&mut ws).await["type"], "editing");
    (ws, presence)
}

/// A Guest's connection subscribed to `main` at `head`: `subscribed` and nothing owed.
async fn guest_subscribed(w: &World, head: u64) -> Socket {
    let mut ws = connected(w.addr, &w.guest).await;
    say(
        &mut ws,
        json!({ "type": "subscribe", "branch": w.main, "after": head }),
    )
    .await;
    assert_eq!(
        next_frame(&mut ws).await,
        json!({ "type": "subscribed", "branch": w.main, "seq": head })
    );
    ws
}

fn refresh(w: &World, seq: u64) -> Value {
    json!({ "type": "refresh", "branch": w.main, "seq": seq })
}

async fn member_id(app: &TestApp, cookie: &str) -> String {
    app.get("/api/me", Some(cookie)).await.body["member"]["id"]
        .as_str()
        .unwrap()
        .to_string()
}

/// An Admin, a Member and a Guest; `main` with two Cards (head 2) and `side` forked at 2.
struct World {
    app: TestApp,
    addr: SocketAddr,
    main: String,
    side: String,
    admin: String,
    bea: String,
    guest: String,
    a: String,
    b: String,
}

async fn world() -> World {
    let app = TestApp::new();
    let admin = app.admin().await;
    let bea = app.join(&admin, "bea@example.org", "member", None).await;
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
    let addr = serve(&app).await;
    World {
        app,
        addr,
        main,
        side,
        admin,
        bea,
        guest,
        a,
        b,
    }
}

#[tokio::test]
async fn an_up_to_date_guest_gets_subscribed_and_nothing_else() {
    let w = world().await;
    let mut guest = guest_subscribed(&w, 2).await;
    silent(&mut guest).await;
    // Subscribing again at the head is answered the same way.
    say(
        &mut guest,
        json!({ "type": "subscribe", "branch": w.main, "after": 2 }),
    )
    .await;
    assert_eq!(
        next_frame(&mut guest).await,
        json!({ "type": "subscribed", "branch": w.main, "seq": 2 })
    );
    silent(&mut guest).await;
}

#[tokio::test]
async fn a_guest_who_is_behind_gets_one_refresh() {
    let w = world().await;
    // Behind, and (which a client should never send) past the head: neither is the head.
    for after in [0u64, 1, 99] {
        let mut guest = connected(w.addr, &w.guest).await;
        say(
            &mut guest,
            json!({ "type": "subscribe", "branch": w.main, "after": after }),
        )
        .await;
        assert_eq!(
            next_frame(&mut guest).await,
            json!({ "type": "subscribed", "branch": w.main, "seq": 2 }),
            "after {after}"
        );
        assert_eq!(
            next_frame(&mut guest).await,
            refresh(&w, 2),
            "after {after}"
        );
        silent(&mut guest).await;
    }
}

#[tokio::test]
async fn a_guest_gets_error_frames_for_its_own_bad_messages_only() {
    let w = world().await;
    let mut guest = connected(w.addr, &w.guest).await;
    say(
        &mut guest,
        json!({ "type": "subscribe", "branch": w.side, "after": 0 }),
    )
    .await;
    let frame = next_frame(&mut guest).await;
    assert_eq!(frame["type"], "error");
    assert_eq!(frame["code"], "forbidden");
    say(
        &mut guest,
        json!({ "type": "subscribe", "branch": new_id(), "after": 0 }),
    )
    .await;
    assert_eq!(next_frame(&mut guest).await["code"], "forbidden");
    // Refused subscriptions subscribe to nothing: Changes on main are not announced.
    w.app
        .ops(&w.admin, &w.main, json!([set_title(&w.a, "A2")]))
        .await;
    silent(&mut guest).await;

    let mut guest = guest_subscribed(&w, 3).await;
    say(&mut guest, json!({ "type": "nonsense" })).await;
    let frame = next_frame(&mut guest).await;
    assert_eq!(frame["type"], "error");
    assert_eq!(frame["code"], "bad_request");
    // A claim from a Guest is ignored without a word.
    say(&mut guest, json!({ "type": "editing", "card": w.a })).await;
    say(
        &mut guest,
        json!({ "type": "editing", "card": "not-an-id" }),
    )
    .await;
    silent(&mut guest).await;
}

#[tokio::test]
async fn a_refresh_follows_ops_a_restore_a_merge_into_main_and_an_accepted_suggestion() {
    let w = world().await;
    let mut guest = guest_subscribed(&w, 2).await;
    let (mut member, _) = member_subscribed(w.addr, &w.bea, &w.main).await;

    // A Member posts ops.
    let res = w
        .app
        .ops(&w.bea, &w.main, json!([set_title(&w.a, "A2")]))
        .await;
    assert_eq!(res.body["seq"], 3);
    assert_eq!(next_frame(&mut guest).await, refresh(&w, 3));
    let frame = next_frame(&mut member).await;
    assert_eq!(frame["type"], "changes");
    assert_eq!(frame["seq"], 3);

    // A Restore.
    let res = w
        .app
        .post(
            &format!("/api/branches/{}/restore", w.main),
            Some(&w.admin),
            json!({ "to_seq": 2 }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let head = res.body["seq"].as_u64().unwrap();
    assert!(head > 3);
    assert_eq!(next_frame(&mut guest).await, refresh(&w, head));
    let frame = next_frame(&mut member).await;
    assert_eq!(frame["type"], "changes");
    assert_eq!(frame["seq"], head);

    // A Merge into main.
    w.app
        .ops(&w.bea, &w.side, json!([set_title(&w.b, "B-side")]))
        .await;
    let plan = w
        .app
        .get(
            &format!("/api/merges/plan?source={}&target={}", w.side, w.main),
            Some(&w.admin),
        )
        .await;
    assert_eq!(plan.status, StatusCode::OK, "{}", plan.text);
    let res = w
        .app
        .post(
            "/api/merges",
            Some(&w.admin),
            json!({ "plan": plan.body["plan"], "decisions": [], "checkpoint": "before side" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let merged = res.body["seq"].as_u64().unwrap();
    assert!(merged > head);
    assert_eq!(next_frame(&mut guest).await, refresh(&w, merged));
    // The Member: the Changes, the Checkpoint, the Branch list (the fork's `branches`
    // frame for the ops on `side` is not one: heads are only announced on a Merge).
    for kind in ["changes", "checkpoint", "branches"] {
        assert_eq!(next_frame(&mut member).await["type"], kind);
    }

    // An accepted Suggestion.
    let token = w.app.access_token(&w.admin, "tools").await;
    let made = w
        .app
        .tool_ok(
            &token,
            "suggest_source",
            json!({ "card": w.a, "doi": "10.1/x", "reason": "Relevant." }),
        )
        .await;
    assert_eq!(next_frame(&mut member).await["type"], "suggestions");
    let (source, attachment) = (new_id(), new_id());
    let res = w
        .app
        .post(
            &format!("/api/suggestions/{}/accept", made["id"].as_str().unwrap()),
            Some(&w.bea),
            json!({ "ops": [
                create(&source, "Source", json!({ "doi": { "Text": "10.1/x" } })),
                create(&attachment, "Attachment", json!({ "card": { "Ref": w.a }, "source": { "Ref": source } })),
            ] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let accepted = res.body["seq"].as_u64().unwrap();
    assert_eq!(accepted, merged + 2);
    assert_eq!(next_frame(&mut guest).await, refresh(&w, accepted));
    assert_eq!(next_frame(&mut member).await["type"], "changes");
    assert_eq!(next_frame(&mut member).await["type"], "suggestions");

    // That was all, for both.
    silent(&mut guest).await;
    assert!(
        frames_within(&mut member, Duration::from_millis(200))
            .await
            .is_empty()
    );
}

#[tokio::test]
async fn quick_changes_are_coalesced_and_the_last_refresh_carries_the_head() {
    let w = world().await;
    let mut guest = guest_subscribed(&w, 2).await;
    let (mut member, _) = member_subscribed(w.addr, &w.bea, &w.main).await;

    const POSTS: u64 = 12;
    let started = Instant::now();
    for i in 0..POSTS {
        w.app
            .ops(&w.bea, &w.main, json!([set_title(&w.a, &format!("A{i}"))]))
            .await;
    }
    let posting = started.elapsed();
    let head = 2 + POSTS;

    let frames = frames_within(&mut guest, SETTLED + Duration::from_millis(700)).await;
    for (_, frame) in &frames {
        assert_eq!(frame["type"], "refresh", "{frame}");
        assert_eq!(frame["branch"], w.main.as_str());
    }
    // The first one is not held back; the last one says where `main` is now.
    assert_eq!(frames.first().unwrap().1, refresh(&w, 3));
    assert_eq!(frames.last().unwrap().1, refresh(&w, head));
    // Their `seq` only grows.
    let seqs: Vec<u64> = frames
        .iter()
        .map(|(_, f)| f["seq"].as_u64().unwrap())
        .collect();
    assert!(seqs.windows(2).all(|p| p[0] < p[1]), "{seqs:?}");
    // At most one per 500 ms: far fewer frames than Changes, and never two close together
    // (measured where they arrive, so with a little slack).
    let most = 2 + posting.as_millis() as usize / 500;
    assert!(
        frames.len() <= most,
        "{} frames in {posting:?}",
        frames.len()
    );
    for pair in frames.windows(2) {
        let gap = pair[1].0.duration_since(pair[0].0);
        assert!(
            gap >= Duration::from_millis(450),
            "two refreshes {gap:?} apart"
        );
    }

    // The Member got every one of them as `changes`, and never a `refresh`.
    let got = frames_within(&mut member, Duration::from_millis(200)).await;
    assert_eq!(got.len() as u64, POSTS);
    for (i, (_, frame)) in got.iter().enumerate() {
        assert_eq!(frame["type"], "changes");
        assert_eq!(frame["seq"], 3 + i as u64);
    }

    // After the window has passed, the next Change is announced at once again.
    let before = Instant::now();
    w.app
        .ops(&w.bea, &w.main, json!([set_title(&w.a, "Later")]))
        .await;
    assert_eq!(next_frame(&mut guest).await, refresh(&w, head + 1));
    assert!(before.elapsed() < Duration::from_millis(400));
    silent(&mut guest).await;
}

#[tokio::test]
async fn a_guest_never_gets_any_other_kind_of_frame() {
    let w = world().await;
    let mut guest = guest_subscribed(&w, 2).await;
    let mut idle_guest = connected(w.addr, &w.guest).await;
    let bea_id = member_id(&w.app, &w.bea).await;

    // presence: Members come, move and go.
    let (mut admin, _) = member_subscribed(w.addr, &w.admin, &w.main).await;
    let (mut bea, presence) = member_subscribed(w.addr, &w.bea, &w.main).await;
    assert_eq!(presence["members"].as_array().unwrap().len(), 2);
    assert_eq!(next_frame(&mut admin).await["type"], "presence");
    say(
        &mut bea,
        json!({ "type": "subscribe", "branch": w.side, "after": 0 }),
    )
    .await;
    assert_eq!(next_frame(&mut admin).await["type"], "presence");

    // editing: a claim and its release.
    say(&mut admin, json!({ "type": "editing", "card": w.a })).await;
    let frame = next_frame(&mut admin).await;
    assert_eq!(frame["type"], "editing");
    assert_eq!(frame["editors"].as_array().unwrap().len(), 1);
    say(&mut admin, json!({ "type": "editing", "card": null })).await;
    assert_eq!(next_frame(&mut admin).await["type"], "editing");

    // checkpoint.
    let res = w
        .app
        .post(
            &format!("/api/branches/{}/checkpoints", w.main),
            Some(&w.admin),
            json!({ "name": "v1" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(next_frame(&mut admin).await["type"], "checkpoint");

    // branches.
    let res = w
        .app
        .post(
            "/api/branches",
            Some(&w.bea),
            json!({ "name": "third", "from": { "branch": w.main, "seq": 1 } }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(next_frame(&mut admin).await["type"], "branches");

    // todos.
    let res = w
        .app
        .post(
            "/api/todos",
            Some(&w.admin),
            json!({ "owner": bea_id, "text": "Look at this" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(next_frame(&mut admin).await["type"], "todos");

    // suggestions: proposed, then rejected.
    let token = w.app.access_token(&w.admin, "tools").await;
    let made = w
        .app
        .tool_ok(
            &token,
            "suggest_source",
            json!({ "card": w.a, "doi": "10.1/x", "reason": "Relevant." }),
        )
        .await;
    assert_eq!(next_frame(&mut admin).await["type"], "suggestions");
    let res = w
        .app
        .post(
            &format!("/api/suggestions/{}/reject", made["id"].as_str().unwrap()),
            Some(&w.admin),
            json!({}),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(next_frame(&mut admin).await["type"], "suggestions");

    // changes on another Branch.
    w.app
        .ops(&w.bea, &w.side, json!([set_title(&w.b, "B-side")]))
        .await;
    // Bea, on `side`, is told (after what her subscribing there brought).
    loop {
        let frame = next_frame(&mut bea).await;
        if frame["type"] == "changes" {
            assert_eq!(frame["branch"], w.side.as_str());
            break;
        }
    }

    // presence again: a Member's connection closing.
    say(
        &mut bea,
        json!({ "type": "subscribe", "branch": w.main, "after": u32::MAX }),
    )
    .await;
    assert_eq!(next_frame(&mut admin).await["type"], "presence");
    drop(bea);
    assert_eq!(next_frame(&mut admin).await["type"], "presence");

    // Through all of it, not one frame for either Guest connection.
    silent(&mut guest).await;
    assert!(
        frames_within(&mut idle_guest, Duration::from_millis(100))
            .await
            .is_empty()
    );

    // Changes on main, with all of the above still going on around them: a `refresh` for
    // the subscribed Guest and nothing else; nothing for the one subscribed to nothing.
    w.app
        .ops(&w.admin, &w.main, json!([set_title(&w.a, "A2")]))
        .await;
    assert_eq!(next_frame(&mut admin).await["type"], "changes");
    say(&mut admin, json!({ "type": "editing", "card": w.b })).await;
    assert_eq!(next_frame(&mut admin).await["type"], "editing");
    let frames = frames_within(&mut guest, SETTLED).await;
    assert_eq!(frames.len(), 1, "{frames:?}");
    assert_eq!(frames[0].1, refresh(&w, 3));
    assert!(
        frames_within(&mut idle_guest, Duration::from_millis(100))
            .await
            .is_empty()
    );
}

#[tokio::test]
async fn members_are_unaffected_and_a_guest_is_not_in_presence() {
    let w = world().await;
    let admin_id = member_id(&w.app, &w.admin).await;
    let bea_id = member_id(&w.app, &w.bea).await;
    let mut both = [admin_id.clone(), bea_id.clone()];
    both.sort();

    // A Guest is there first, and a second one of its connections too.
    let mut guest = guest_subscribed(&w, 2).await;
    let _second = guest_subscribed(&w, 2).await;

    // A Member who is behind still gets `subscribed`, the catch-up, `presence`, `editing`.
    let mut admin = connected(w.addr, &w.admin).await;
    say(
        &mut admin,
        json!({ "type": "subscribe", "branch": w.main, "after": 1 }),
    )
    .await;
    assert_eq!(
        next_frame(&mut admin).await,
        json!({ "type": "subscribed", "branch": w.main, "seq": 2 })
    );
    let catch_up = next_frame(&mut admin).await;
    assert_eq!(catch_up["type"], "changes");
    assert_eq!(catch_up["seq"], 2);
    assert_eq!(catch_up["changes"].as_array().unwrap().len(), 1);
    // Only the Member is present, although two Guest connections are subscribed.
    assert_eq!(
        next_frame(&mut admin).await,
        json!({ "type": "presence", "branch": w.main, "members": [admin_id] })
    );
    assert_eq!(
        next_frame(&mut admin).await,
        json!({ "type": "editing", "branch": w.main, "editors": [] })
    );

    // A Guest arriving or leaving changes nobody's presence.
    let third = guest_subscribed(&w, 2).await;
    drop(third);
    assert!(
        frames_within(&mut admin, Duration::from_millis(200))
            .await
            .is_empty()
    );

    // Another Member arriving does, for Members only.
    let (mut bea, presence) = member_subscribed(w.addr, &w.bea, &w.main).await;
    let expected = json!({ "type": "presence", "branch": w.main, "members": both });
    assert_eq!(presence, expected);
    assert_eq!(next_frame(&mut admin).await, expected);

    // Changes reach Members as `changes`, in full, and never as a `refresh`.
    let res = w
        .app
        .ops(&w.bea, &w.main, json!([set_title(&w.a, "A2")]))
        .await;
    let expected = json!({
        "type": "changes",
        "branch": w.main,
        "seq": 3,
        "changes": res.body["changes"],
    });
    for ws in [&mut admin, &mut bea] {
        assert_eq!(next_frame(ws).await, expected);
    }
    assert_eq!(next_frame(&mut guest).await, refresh(&w, 3));
    for ws in [&mut admin, &mut bea] {
        let more = frames_within(ws, SETTLED).await;
        assert!(more.is_empty(), "{more:?}");
    }
    silent(&mut guest).await;

    // The Guest going away is not news either.
    drop(guest);
    assert!(
        frames_within(&mut admin, Duration::from_millis(200))
            .await
            .is_empty()
    );
}
