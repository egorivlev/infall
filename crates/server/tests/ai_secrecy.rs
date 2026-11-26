//! A Member's OpenRouter key never reaches the logs or a response, and neither does a
//! Conversation. This file holds one test because it installs a process-wide log
//! subscriber.

mod common;

use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use base64::Engine;
use common::openrouter::*;
use common::*;
use http_body_util::BodyExt;
use infall_server::secret::SecretKey;
use infall_server::store::{MemoryStore, SqliteStore};
use serde_json::json;
use tower::ServiceExt;

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn the_key_and_the_conversation_never_reach_the_logs_or_a_response() {
    let captured = Captured::default();
    let writer = captured.clone();
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .init();

    let upstream = Upstream::start().await;
    let elsewhere = Upstream::start().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("infall.db");
    let secret = SecretKey::generate().unwrap();
    let secret_text = secret.to_base64();
    let url = upstream.url.clone();
    let app = TestApp::with_config(Arc::new(SqliteStore::open(&path).unwrap()), {
        let secret = secret.clone();
        move |c| {
            c.secret_key = Some(secret);
            c.openrouter_url = url;
            c.ai_idle_timeout = Duration::from_millis(250);
        }
    });
    let admin = app.admin().await;
    let main = app.main_branch(&admin).await;
    let card = new_id();
    app.ops(
        &admin,
        &main,
        json!([create_card(&card, "CARD-TITLE-MARKER")]),
    )
    .await;

    // Everything any response said, to be searched at the end.
    let mut said: Vec<String> = Vec::new();

    // Setting the key, well and badly.
    for bad in [
        json!({ "key": format!("{KEY} with a space") }),
        json!({ "key": format!("{KEY}{}", "x".repeat(400)) }),
        json!({ "key": [KEY] }),
        json!({ "key": { "nested": KEY } }),
        json!({ "kee": KEY }),
        json!(KEY),
    ] {
        let res = app.put("/api/ai/key", Some(&admin), bad).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST);
        said.push(res.text);
    }
    let broken = Request::builder()
        .method(Method::PUT)
        .uri("/api/ai/key")
        .header(header::ORIGIN, ORIGIN)
        .header("x-infall-request", "1")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::COOKIE, &admin)
        .body(Body::from(format!("{{\"key\": \"{KEY}")))
        .unwrap();
    said.push(app.send(broken).await.text);
    let res = app
        .put("/api/ai/key", Some(&admin), json!({ "key": KEY }))
        .await;
    assert_eq!(res.status, StatusCode::OK);
    said.push(res.text);
    said.push(
        app.put("/api/ai/model", Some(&admin), json!({ "model": MODEL }))
            .await
            .text,
    );
    said.push(app.get("/api/ai/status", Some(&admin)).await.text);
    said.push(app.get("/api/ai/models", Some(&admin)).await.text);
    said.push(app.get("/api/me", Some(&admin)).await.text);

    // Turns that work: plain, and with tools (a read, a failed call, an unknown tool, a
    // Suggestion).
    let user_text = "USER-MESSAGE-MARKER what is on the Board?";
    upstream.push(Reply::answer(&["ANSWER-MARKER one", " two"]));
    // (Kept apart: these responses rightly hold the answer; they must not hold the key.)
    let mut answers = vec![app.chat(&admin, user_text).await.res.text];
    let get = json!({ "card": card }).to_string();
    let suggest = json!({ "card": card, "doi": "10.1/x", "reason": "REASON-MARKER" }).to_string();
    upstream.push(Reply::tools(&[
        ("a", "get_card", &get),
        ("b", "get_card", r#"{"card":"ARGUMENT-MARKER"}"#),
        ("c", "TOOLNAME-MARKER", "{}"),
        ("d", "suggest_source", &suggest),
        ("e", "list_cards", "{not json ARGUMENT-MARKER"),
    ]));
    upstream.push(Reply::answer(&["ANSWER-MARKER after tools"]));
    let chat = app.chat(&admin, user_text).await;
    assert_eq!(chat.tools().len(), 4);
    answers.push(chat.res.text);

    // Every way upstream can fail, with bodies that quote the request's Authorization
    // header back.
    let echo = format!(
        "{{\"error\":{{\"message\":\"UPSTREAM-BODY Authorization: Bearer {KEY}\",\"code\":401,\"headers\":{{\"authorization\":\"Bearer {KEY}\"}}}}}}"
    );
    let failures = vec![
        Reply::status(401, &echo),
        Reply::status(402, &echo),
        Reply::status(403, &echo),
        Reply::status(404, &echo),
        Reply::status(429, &echo),
        Reply::status(500, &echo),
        Reply::status(503, &echo),
        Reply::status(200, &echo),
        Reply::raw(format!("data: {echo}\n\n")),
        Reply::raw(format!("data: UPSTREAM-BODY Bearer {KEY}\n\n")),
        Reply::raw(format!("UPSTREAM-BODY Bearer {KEY}\n")),
        Reply::raw(format!(
            "data: {{\"choices\":[{{\"delta\":{{\"content\":\"{KEY}"
        )),
        Reply::status(302, &echo)
            .header("location", &format!("{}/chat/completions", elsewhere.url)),
        Reply::status(307, &echo).header("location", &format!("{}/x?key={KEY}", elsewhere.url)),
        Reply::steps(vec![Step::Hang]),
        Reply::answer(&["late"]).after(2_000),
        Reply::steps(vec![Step::Drip(format!(": {KEY}\n\n").into_bytes(), 30)]),
    ];
    for reply in failures {
        app.clock.advance(10_000);
        upstream.push(reply);
        let chat = app.chat(&admin, user_text).await;
        assert_eq!(chat.types(), ["error"], "{}", chat.res.text);
        said.push(chat.res.text);
    }
    // A failure after a tool round.
    app.clock.advance(10_000);
    upstream.push(Reply::tools(&[("a", "get_card", &get)]));
    upstream.push(Reply::status(500, &echo));
    said.push(app.chat(&admin, user_text).await.res.text);

    // The model list failing, with the same kind of body.
    app.clock.advance(2 * 60 * 60 * 1000);
    upstream.models(Reply::status(500, &echo));
    let res = app.get("/api/ai/models", Some(&admin)).await;
    assert_eq!(res.status, StatusCode::BAD_GATEWAY);
    said.push(res.text);
    upstream.models(Reply::status(200, &echo));
    said.push(app.get("/api/ai/models", Some(&admin)).await.text);

    // A client that goes away mid-answer.
    upstream.push(Reply::steps(vec![
        Step::Send(sse(&text_events(&["x"]))[..40].to_vec()),
        Step::Hang,
    ]));
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/ai/chat")
        .header(header::ORIGIN, ORIGIN)
        .header("x-infall-request", "1")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::COOKIE, &admin)
        .body(Body::from(
            json!({ "messages": [{ "role": "user", "content": user_text }] }).to_string(),
        ))
        .unwrap();
    let res = app.router.clone().oneshot(req).await.unwrap();
    let mut body = res.into_body();
    let _ = tokio::time::timeout(Duration::from_millis(100), body.frame()).await;
    drop(body);
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Refusals before a turn starts.
    app.clock.advance(120_000);
    for _ in 0..25 {
        said.push(
            app.chat_raw(
                Some(&admin),
                json!({ "messages": [{ "role": "user", "content": user_text }] }),
            )
            .await
            .res
            .text,
        );
    }
    said.push(
        app.chat_raw(
            Some(&admin),
            json!({ "messages": [{ "role": "system", "content": KEY }, { "role": "user", "content": user_text }] }),
        )
        .await
        .res
        .text,
    );

    // An upstream that is not there.
    {
        let closed = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}/api/v1", l.local_addr().unwrap())
        };
        let app = TestApp::with_ai(Arc::new(MemoryStore::new()), &closed);
        let admin = app.admin().await;
        app.ai_ready(&admin).await;
        let chat = app.chat(&admin, user_text).await;
        assert_eq!(chat.types(), ["error"]);
        said.push(chat.res.text);
        said.push(app.get("/api/ai/models", Some(&admin)).await.text);
    }

    // The same database under another secret key: the stored key cannot be read.
    {
        let store = Arc::new(SqliteStore::open(&path).unwrap());
        let app = TestApp::with_ai(store, &upstream.url);
        let admin = app.login("admin@example.org", PASSWORD).await.cookie();
        let chat = app
            .chat_raw(
                Some(&admin),
                json!({ "messages": [{ "role": "user", "content": user_text }] }),
            )
            .await;
        assert_eq!(chat.res.code(), "no_key");
        said.push(chat.res.text);
        said.push(app.get("/api/ai/status", Some(&admin)).await.text);
    }

    // The store failing under every route.
    let stored: Vec<u8> = rusqlite::Connection::open(&path)
        .unwrap()
        .query_row("SELECT key_ciphertext FROM ai_settings", [], |r| r.get(0))
        .unwrap();
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch("DROP TABLE ai_settings")
        .unwrap();
    app.clock.advance(120_000);
    for res in [
        app.get("/api/ai/status", Some(&admin)).await,
        app.put("/api/ai/key", Some(&admin), json!({ "key": KEY }))
            .await,
        app.delete("/api/ai/key", Some(&admin)).await,
        app.put("/api/ai/model", Some(&admin), json!({ "model": MODEL }))
            .await,
        app.chat_raw(
            Some(&admin),
            json!({ "messages": [{ "role": "user", "content": user_text }] }),
        )
        .await
        .res,
    ] {
        assert_eq!(
            res.status,
            StatusCode::INTERNAL_SERVER_ERROR,
            "{}",
            res.text
        );
        said.push(res.text);
    }

    // Nothing was ever sent anywhere but the configured upstream, and every request there
    // was one of the two it should be.
    assert!(elsewhere.seen().is_empty());
    for req in upstream.seen() {
        assert!(
            req.path == "/api/v1/chat/completions" || req.path == "/api/v1/models",
            "{}",
            req.path
        );
    }

    let logs = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
    // The capture works: what should be logged was...
    assert!(logs.contains("OpenRouter key stored"), "{logs}");
    assert!(logs.contains("AI turn failed"), "{logs}");
    assert!(logs.contains("AI turn done"), "{logs}");
    assert!(logs.contains("the client went away"), "{logs}");
    assert!(logs.contains("model list"), "{logs}");
    assert!(logs.contains("no such table"), "{logs}");
    // (the HTTP client's own TRACE output is part of what is searched)
    assert!(
        logs.contains("TRACE reqwest") && logs.contains("hyper_util"),
        "{logs}"
    );
    for why in [
        "refused",
        "no credit",
        "rate limited",
        "unavailable",
        "timed out",
        "unreachable",
        "unexpected answer",
        "cut off",
    ] {
        assert!(
            logs.contains(&format!("why=\"{why}\"")),
            "{why} was not logged"
        );
    }

    // ...and the key is nowhere: not whole, not in part, not under any wrapping.
    let key_parts = [
        KEY,
        &KEY[..16],
        &KEY[9..30],
        &KEY[KEY.len() - 20..],
        "sk-or-v1",
        "Bearer sk",
    ];
    let b64 = base64::engine::general_purpose::STANDARD.encode(KEY);
    let hex: String = stored.iter().map(|b| format!("{b:02x}")).collect();
    for (what, text) in [("the logs", &logs)]
        .into_iter()
        .chain(said.iter().map(|t| ("a response", t)))
        .chain(answers.iter().map(|t| ("a response", t)))
    {
        for part in key_parts {
            assert!(!text.contains(part), "{what} holds part of the key: {part}");
        }
        assert!(!text.contains(&b64[..24]), "{what} holds the key in base64");
        assert!(
            !text.contains(&secret_text),
            "{what} holds the server's secret key"
        );
        assert!(
            !text.contains(&secret_text[..20]),
            "{what} holds the server's secret key"
        );
        assert!(!text.contains(&hex[..32]), "{what} holds the ciphertext");
        // No upstream body was passed on or written down.
        assert!(
            !text.contains("UPSTREAM-BODY"),
            "{what} holds an upstream body"
        );
    }
    // No Conversation is logged: not what the Member wrote, not what the model answered,
    // not what tools were called with or what they returned.
    for marker in [
        "USER-MESSAGE-MARKER",
        "ANSWER-MARKER",
        "ARGUMENT-MARKER",
        "TOOLNAME-MARKER",
        "REASON-MARKER",
        "CARD-TITLE-MARKER",
    ] {
        assert!(!logs.contains(marker), "the logs hold {marker}");
    }
    // Error responses never repeat what was asked either.
    for text in &said {
        assert!(
            !text.contains("ANSWER-MARKER") && !text.contains("USER-MESSAGE-MARKER"),
            "{text}"
        );
    }
}
