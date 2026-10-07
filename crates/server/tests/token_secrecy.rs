//! The secret of an access token never reaches the logs. This file holds one test because
//! it installs a process-wide log subscriber.

mod common;

use std::io::Write;
use std::sync::{Arc, Mutex};

use axum::http::StatusCode;
use common::*;
use qoop_server::store::SqliteStore;
use serde_json::json;

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
async fn the_secret_never_reaches_the_logs() {
    let captured = Captured::default();
    let writer = captured.clone();
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .init();

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("qoop.db");
    let app = TestApp::with_store(Arc::new(SqliteStore::open(&path).unwrap()));
    let admin = app.admin().await;
    let main = app.main_branch(&admin).await;
    let card = new_id();
    app.ops(&admin, &main, json!([create_card(&card, "A")]))
        .await;

    let secret = app.access_token(&admin, "logged?").await;
    let tail = secret.strip_prefix("qoop_pat_").unwrap().to_string();
    let wrong = format!("qoop_pat_{}", "W".repeat(43));

    // Use it every way there is: well, badly, in the wrong place, and into faults.
    app.rpc(&secret, "initialize", json!({})).await;
    app.tool_ok(&secret, "list_cards", json!({})).await;
    app.tool_err(&secret, "get_card", json!({ "card": "nope" }))
        .await;
    app.mcp_raw(Some(&secret), "{broken".into()).await;
    app.rpc(&wrong, "ping", json!({})).await;
    app.get("/api/me", Some(&format!("qoop_session={secret}")))
        .await;
    for _ in 0..125 {
        app.rpc(&secret, "ping", json!({})).await;
    }
    app.clock.advance(120_000);
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch("DROP TABLE suggestions")
        .unwrap();
    let failed = app
        .tool_err(
            &secret,
            "suggest_source",
            json!({ "card": card, "doi": "10.1/x", "reason": "r" }),
        )
        .await;
    assert_eq!(
        failed,
        "Something went wrong on the server. Try again later."
    );
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch("DROP TABLE access_tokens")
        .unwrap();
    let res = app.rpc(&secret, "ping", json!({})).await;
    assert_eq!(res.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(!res.text.contains(&tail));
    let res = app.get("/api/tokens", Some(&admin)).await;
    assert_eq!(res.status, StatusCode::INTERNAL_SERVER_ERROR);

    let logs = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
    // The faults were logged (so the capture works), with their cause...
    assert!(logs.contains("tool call failed"), "{logs}");
    assert!(logs.contains("no such table"), "{logs}");
    assert!(logs.contains("access token created"), "{logs}");
    // ...and no log line holds a secret, sent rightly or wrongly.
    assert!(!logs.contains(&tail), "the secret was logged");
    assert!(!logs.contains("qoop_pat_"), "a bearer value was logged");
    assert!(!logs.contains(&"W".repeat(43)));
}
