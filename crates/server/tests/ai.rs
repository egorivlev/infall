//! The OpenRouter path of the AI sidebar (contract §14): who may use it, a Member's key
//! and model, the model list, and how the key is kept.

mod common;

use std::process::Command;
use std::sync::Arc;

use axum::http::{Method, StatusCode};
use base64::Engine;
use common::openrouter::*;
use common::*;
use infall_core::MemberId;
use infall_server::secret::SecretKey;
use infall_server::store::{MemoryStore, SCHEMA_VERSION, SqliteStore, Store};
use serde_json::{Value, json};

fn stores() -> Vec<Arc<dyn Store>> {
    vec![
        Arc::new(MemoryStore::new()),
        Arc::new(SqliteStore::open_in_memory().unwrap()),
    ]
}

async fn member_id(app: &TestApp, cookie: &str) -> MemberId {
    let id = app.get("/api/me", Some(cookie)).await.body["member"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    MemberId(uuid::Uuid::parse_str(&id).unwrap())
}

fn user(text: &str) -> Value {
    json!({ "messages": [{ "role": "user", "content": text }] })
}

/// Every route of §14 with a body it would accept.
fn routes() -> Vec<(Method, &'static str, Value)> {
    vec![
        (Method::GET, "/api/ai/status", Value::Null),
        (Method::PUT, "/api/ai/key", json!({ "key": KEY })),
        (Method::DELETE, "/api/ai/key", Value::Null),
        (Method::PUT, "/api/ai/model", json!({ "model": MODEL })),
        (Method::GET, "/api/ai/models", Value::Null),
        (Method::POST, "/api/ai/chat", user("hello")),
    ]
}

async fn call(
    app: &TestApp,
    method: &Method,
    path: &str,
    cookie: Option<&str>,
    body: Value,
) -> Res {
    if method == Method::GET {
        app.get(path, cookie).await
    } else {
        app.write(method.clone(), path, cookie, body).await
    }
}

// ---------------------------------------------------------------- who may use it

#[tokio::test]
async fn guests_and_strangers_are_refused_on_every_route() {
    let upstream = Upstream::start().await;
    let app = TestApp::ai(&upstream);
    let admin = app.admin().await;
    app.ai_ready(&admin).await;
    let guest = app
        .join(
            &admin,
            "guest@example.org",
            "guest",
            Some(START + 86_400_000),
        )
        .await;
    for (method, path, body) in routes() {
        let res = call(&app, &method, path, Some(&guest), body.clone()).await;
        assert_eq!(res.status, StatusCode::FORBIDDEN, "{method} {path}");
        assert_eq!(res.code(), "forbidden", "{method} {path}");
        let res = call(&app, &method, path, None, body).await;
        assert_eq!(res.status, StatusCode::UNAUTHORIZED, "{method} {path}");
    }
    // Nothing a Guest sent reached OpenRouter, and nothing was stored for them.
    assert!(upstream.seen().is_empty());
    let guest_id = member_id(&app, &guest).await;
    assert_eq!(app.store.ai_settings(guest_id).unwrap(), Default::default());

    // A Guest whose access has run out is signed out here like everywhere else.
    app.clock.advance(2 * 86_400_000);
    let res = app.get("/api/ai/status", Some(&guest)).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn writes_need_the_app_origin_and_an_access_token_is_not_a_session() {
    let upstream = Upstream::start().await;
    let app = TestApp::ai(&upstream);
    let admin = app.admin().await;
    app.ai_ready(&admin).await;
    for (method, path, body) in routes() {
        if method == Method::GET {
            continue;
        }
        let req = axum::http::Request::builder()
            .method(method.clone())
            .uri(path)
            .header("cookie", &admin)
            .header("content-type", "application/json")
            .body(axum::body::Body::from(body.to_string()))
            .unwrap();
        let res = app.send(req).await;
        assert_eq!(res.status, StatusCode::FORBIDDEN, "{method} {path}");
        assert_eq!(res.code(), "forbidden_origin");
    }
    // A bearer token acts only on /mcp.
    let token = app.access_token(&admin, "t").await;
    let req = axum::http::Request::builder()
        .method(Method::GET)
        .uri("/api/ai/status")
        .header("authorization", format!("Bearer {token}"))
        .body(axum::body::Body::empty())
        .unwrap();
    assert_eq!(app.send(req).await.status, StatusCode::UNAUTHORIZED);
    assert!(upstream.seen().is_empty());
}

#[tokio::test]
async fn without_a_secret_key_the_path_is_off() {
    let upstream = Upstream::start().await;
    let url = upstream.url.clone();
    let app = TestApp::with_config(Arc::new(MemoryStore::new()), move |c| {
        c.openrouter_url = url;
    });
    let admin = app.admin().await;
    let status = app.get("/api/ai/status", Some(&admin)).await;
    assert_eq!(status.status, StatusCode::OK);
    assert_eq!(status.body, json!({ "enabled": false }));
    for (method, path, body) in routes() {
        if path == "/api/ai/status" {
            continue;
        }
        let res = call(&app, &method, path, Some(&admin), body).await;
        assert_eq!(
            res.status,
            StatusCode::SERVICE_UNAVAILABLE,
            "{method} {path}"
        );
        assert_eq!(res.code(), "ai_not_configured", "{method} {path}");
        assert!(res.body["error"]["message"].as_str().unwrap().len() > 10);
    }
    assert!(
        upstream.seen().is_empty(),
        "nothing is called when it is off"
    );
    let id = member_id(&app, &admin).await;
    assert_eq!(app.store.ai_settings(id).unwrap(), Default::default());
}

// ---------------------------------------------------------------- key and model

#[tokio::test]
async fn a_key_and_a_model_are_set_replaced_and_removed() {
    let upstream = Upstream::start().await;
    for store in stores() {
        let app = TestApp::with_ai(store, &upstream.url);
        let admin = app.admin().await;
        let bea = app.join(&admin, "bea@example.org", "member", None).await;
        let mut said = Vec::new();

        let res = app.get("/api/ai/status", Some(&admin)).await;
        assert_eq!(res.body, json!({ "enabled": true }));

        let res = app
            .put("/api/ai/key", Some(&admin), json!({ "key": KEY }))
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        assert_eq!(
            res.body,
            json!({ "enabled": true, "key": { "last4": "TAIL", "added_at": START } })
        );
        said.push(res.text);

        let res = app
            .put(
                "/api/ai/model",
                Some(&admin),
                json!({ "model": "anthropic/claude-sonnet-4.5" }),
            )
            .await;
        assert_eq!(
            res.body,
            json!({ "enabled": true, "key": { "last4": "TAIL", "added_at": START },
                    "model": "anthropic/claude-sonnet-4.5" })
        );
        said.push(res.text);

        // Replacing the key keeps the model; the new key is the one in use.
        app.clock.advance(5_000);
        let second = format!("{}-wxyz", "sk-or-v1-second".repeat(3));
        let res = app
            .put("/api/ai/key", Some(&admin), json!({ "key": second }))
            .await;
        assert_eq!(
            res.body,
            json!({ "enabled": true, "key": { "last4": "wxyz", "added_at": START + 5_000 },
                    "model": "anthropic/claude-sonnet-4.5" })
        );
        said.push(res.text);
        let chat = app.chat(&admin, "hi").await;
        assert_eq!(chat.last()["type"], "done");
        assert_eq!(
            upstream.chats().last().unwrap().header("authorization"),
            format!("Bearer {second}")
        );
        said.push(chat.res.text);

        // Each Member has their own.
        assert_eq!(
            app.get("/api/ai/status", Some(&bea)).await.body,
            json!({ "enabled": true })
        );
        let res = app
            .put("/api/ai/model", Some(&bea), json!({ "model": MODEL }))
            .await;
        assert_eq!(res.body, json!({ "enabled": true, "model": MODEL }));

        let status = app.get("/api/ai/status", Some(&admin)).await;
        assert_eq!(status.body["key"]["last4"], "wxyz");
        said.push(status.text);

        // Removing the key keeps the model; removing it again is fine.
        for _ in 0..2 {
            let res = app.delete("/api/ai/key", Some(&admin)).await;
            assert_eq!(res.status, StatusCode::OK);
            assert_eq!(
                res.body,
                json!({ "enabled": true, "model": "anthropic/claude-sonnet-4.5" })
            );
        }
        let chat = app.chat_raw(Some(&admin), user("hi")).await;
        assert_eq!(chat.res.status, StatusCode::CONFLICT);
        assert_eq!(chat.res.code(), "no_key");

        // Nothing said back either key.
        for text in said {
            assert!(!text.contains(KEY) && !text.contains(&second), "{text}");
            assert!(!text.contains("sk-or-v1"), "{text}");
        }
    }
}

#[tokio::test]
async fn keys_and_model_ids_are_checked_and_a_bad_key_is_never_repeated() {
    let upstream = Upstream::start().await;
    let app = TestApp::ai(&upstream);
    let admin = app.admin().await;
    let secretish = "sk-or-v1-SHOULD-NOT-COME-BACK";
    for bad in [
        json!({ "key": "short" }),
        json!({ "key": format!("{secretish} with spaces in it") }),
        json!({ "key": format!("{secretish}{}", "x".repeat(400)) }),
        json!({ "key": format!("{secretish}-ünïcödé-ünïcödé") }),
        json!({ "key": format!("{secretish}\nsecond-line") }),
        json!({ "key": [format!("{secretish}-in-an-array")] }),
        json!({ "key": { "value": format!("{secretish}-in-an-object") } }),
        json!({ "key": 12345678901234567890u64 }),
        json!({ "key": null }),
        json!({ "KEY": format!("{secretish}-wrong-field-name") }),
        json!([format!("{secretish}-bare-array")]),
        json!(format!("{secretish}-bare-string")),
    ] {
        let res = app.put("/api/ai/key", Some(&admin), bad.clone()).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{bad}");
        assert_eq!(res.code(), "bad_request");
        assert!(!res.text.contains("SHOULD-NOT"), "{}", res.text);
    }
    assert_eq!(
        app.get("/api/ai/status", Some(&admin)).await.body,
        json!({ "enabled": true })
    );
    // The limits themselves are fine.
    for good in ["k".repeat(20), "k".repeat(400)] {
        let res = app
            .put("/api/ai/key", Some(&admin), json!({ "key": good }))
            .await;
        assert_eq!(res.status, StatusCode::OK);
        assert_eq!(res.body["key"]["last4"], "kkkk");
    }

    for bad in [
        json!({ "model": "" }),
        json!({ "model": "m".repeat(121) }),
        json!({ "model": "has space" }),
        json!({ "model": "quote\"d" }),
        json!({ "model": "line\nbreak" }),
        json!({ "model": 5 }),
        json!({}),
    ] {
        let res = app.put("/api/ai/model", Some(&admin), bad.clone()).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{bad}");
    }
    assert!(app.get("/api/ai/status", Some(&admin)).await.body["model"].is_null());
    let res = app
        .put(
            "/api/ai/model",
            Some(&admin),
            json!({ "model": "m".repeat(120) }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
}

// ---------------------------------------------------------------- how the key is kept

#[tokio::test]
async fn the_key_is_sealed_in_the_database_file() {
    let upstream = Upstream::start().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("infall.db");
    let app = TestApp::with_ai(Arc::new(SqliteStore::open(&path).unwrap()), &upstream.url);
    let admin = app.admin().await;
    app.ai_ready(&admin).await;
    let id = member_id(&app, &admin).await;

    let conn = rusqlite::Connection::open(&path).unwrap();
    let (ciphertext, nonce, last4, added_at, model): (Vec<u8>, Vec<u8>, String, i64, String) = conn
        .query_row(
            "SELECT key_ciphertext, key_nonce, key_last4, key_added_at, model FROM ai_settings WHERE member_id = ?1",
            [id.0.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .unwrap();
    assert_eq!(
        (last4.as_str(), added_at, model.as_str()),
        ("TAIL", START, MODEL)
    );
    assert_eq!(nonce.len(), 24);
    // Ciphertext is the key's length plus the 16-byte tag, and holds none of it.
    assert_eq!(ciphertext.len(), KEY.len() + 16);
    let holds = |hay: &[u8], needle: &[u8]| hay.windows(needle.len()).any(|w| w == needle);
    assert!(!holds(&ciphertext, b"sk-or"));
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    drop(conn);
    for entry in std::fs::read_dir(dir.path()).unwrap() {
        let file = entry.unwrap().path();
        let bytes = std::fs::read(&file).unwrap();
        assert!(!holds(&bytes, KEY.as_bytes()), "{}", file.display());
        assert!(!holds(&bytes, &KEY.as_bytes()[..24]), "{}", file.display());
    }

    // Storing the same key again uses a fresh nonce and gives a different ciphertext.
    app.ai_ready(&admin).await;
    let again = app.store.ai_settings(id).unwrap().key.unwrap();
    assert_ne!(again.nonce, nonce);
    assert_ne!(again.ciphertext, ciphertext);
}

#[tokio::test]
async fn a_restart_keeps_the_key_readable_and_another_secret_key_does_not() {
    let upstream = Upstream::start().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("infall.db");
    let secret = SecretKey::generate().unwrap();
    let open = || -> Arc<dyn Store> { Arc::new(SqliteStore::open(&path).unwrap()) };
    {
        let app = TestApp::with_ai_key(open(), &upstream.url, secret.clone());
        let admin = app.admin().await;
        app.ai_ready(&admin).await;
    }

    // The same secret key after a restart: the key works.
    {
        let app = TestApp::with_ai_key(open(), &upstream.url, secret.clone());
        let admin = app.login("admin@example.org", PASSWORD).await.cookie();
        let status = app.get("/api/ai/status", Some(&admin)).await;
        assert_eq!(
            status.body,
            json!({ "enabled": true, "key": { "last4": "TAIL", "added_at": START }, "model": MODEL })
        );
        let chat = app.chat(&admin, "hi").await;
        assert_eq!(chat.last()["type"], "done");
        assert_eq!(
            upstream.chats().last().unwrap().header("authorization"),
            format!("Bearer {KEY}")
        );
    }
    let asked = upstream.chats().len();

    // A different secret key: the stored key is unusable, said plainly, and can be added
    // again.
    {
        let app = TestApp::with_ai_key(open(), &upstream.url, SecretKey::generate().unwrap());
        let admin = app.login("admin@example.org", PASSWORD).await.cookie();
        let status = app.get("/api/ai/status", Some(&admin)).await;
        assert_eq!(status.status, StatusCode::OK);
        assert_eq!(status.body, json!({ "enabled": true, "model": MODEL }));
        let chat = app.chat_raw(Some(&admin), user("hi")).await;
        assert_eq!(chat.res.status, StatusCode::CONFLICT);
        assert_eq!(chat.res.code(), "no_key");
        assert_eq!(
            chat.res.body["error"]["message"],
            "The stored OpenRouter key can no longer be read. Add it again."
        );
        assert_eq!(upstream.chats().len(), asked, "nothing was sent upstream");

        app.ai_ready(&admin).await;
        assert_eq!(app.chat(&admin, "hi").await.last()["type"], "done");
    }

    // No secret key at all: off, and the stored key is not listed.
    {
        let url = upstream.url.clone();
        let app = TestApp::with_config(open(), move |c| c.openrouter_url = url);
        let admin = app.login("admin@example.org", PASSWORD).await.cookie();
        assert_eq!(
            app.get("/api/ai/status", Some(&admin)).await.body,
            json!({ "enabled": false, "model": MODEL })
        );
    }
}

#[tokio::test]
async fn a_tampered_or_moved_ciphertext_is_unusable_and_nothing_panics() {
    let upstream = Upstream::start().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("infall.db");
    let app = TestApp::with_ai(Arc::new(SqliteStore::open(&path).unwrap()), &upstream.url);
    let admin = app.admin().await;
    let bea = app.join(&admin, "bea@example.org", "member", None).await;
    app.ai_ready(&admin).await;
    app.ai_ready(&bea).await;
    let (ada_id, bea_id) = (member_id(&app, &admin).await, member_id(&app, &bea).await);
    let good = app.store.ai_settings(ada_id).unwrap().key.unwrap();
    let conn = rusqlite::Connection::open(&path).unwrap();
    let set = |ciphertext: &[u8], nonce: &[u8]| {
        conn.execute(
            "UPDATE ai_settings SET key_ciphertext = ?1, key_nonce = ?2 WHERE member_id = ?3",
            rusqlite::params![ciphertext, nonce, ada_id.0.to_string()],
        )
        .unwrap();
    };
    let mut flipped = good.ciphertext.clone();
    flipped[3] ^= 0x40;
    let mut other_nonce = good.nonce.clone();
    other_nonce[0] ^= 1;
    let beas = app.store.ai_settings(bea_id).unwrap().key.unwrap();
    let cases: Vec<(Vec<u8>, Vec<u8>)> = vec![
        (flipped, good.nonce.clone()),
        (good.ciphertext.clone(), other_nonce),
        (good.ciphertext[..10].to_vec(), good.nonce.clone()),
        (Vec::new(), good.nonce.clone()),
        (good.ciphertext.clone(), vec![1, 2, 3]),
        (good.ciphertext.clone(), Vec::new()),
        // Another Member's sealed key, copied into this row.
        (beas.ciphertext.clone(), beas.nonce.clone()),
    ];
    let asked = upstream.chats().len();
    for (ciphertext, nonce) in cases {
        set(&ciphertext, &nonce);
        let status = app.get("/api/ai/status", Some(&admin)).await;
        assert_eq!(status.body, json!({ "enabled": true, "model": MODEL }));
        let chat = app.chat_raw(Some(&admin), user("hi")).await;
        assert_eq!(chat.res.status, StatusCode::CONFLICT);
        assert_eq!(chat.res.code(), "no_key");
        assert!(
            chat.res.body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("can no longer be read")
        );
    }
    assert_eq!(upstream.chats().len(), asked);
    // Put back, it works again; and Bea's was never affected.
    set(&good.ciphertext, &good.nonce);
    assert_eq!(app.chat(&admin, "hi").await.last()["type"], "done");
    assert_eq!(app.chat(&bea, "hi").await.last()["type"], "done");
}

#[tokio::test]
async fn removing_a_member_deletes_their_ai_settings() {
    let upstream = Upstream::start().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("infall.db");
    let file: Arc<dyn Store> = Arc::new(SqliteStore::open(&path).unwrap());
    for (store, on_disk) in [
        (Arc::new(MemoryStore::new()) as Arc<dyn Store>, false),
        (file, true),
    ] {
        let app = TestApp::with_ai(store, &upstream.url);
        let admin = app.admin().await;
        let bea = app.join(&admin, "bea@example.org", "member", None).await;
        app.ai_ready(&admin).await;
        app.ai_ready(&bea).await;
        let (ada_id, bea_id) = (member_id(&app, &admin).await, member_id(&app, &bea).await);
        assert!(app.store.ai_settings(bea_id).unwrap().key.is_some());

        let res = app
            .delete(&format!("/api/members/{}", bea_id.0), Some(&admin))
            .await;
        assert_eq!(res.status, StatusCode::OK);
        assert_eq!(app.store.ai_settings(bea_id).unwrap(), Default::default());
        assert!(app.store.ai_settings(ada_id).unwrap().key.is_some());
        if on_disk {
            let rows: i64 = rusqlite::Connection::open(&path)
                .unwrap()
                .query_row("SELECT COUNT(*) FROM ai_settings", [], |r| r.get(0))
                .unwrap();
            assert_eq!(rows, 1);
        }
        // Settings cannot be stored for an account that is gone.
        assert!(!app.store.set_ai_model(bea_id, MODEL).unwrap());
        assert!(!app.store.set_ai_key(bea_id, None).unwrap());
        assert_eq!(app.store.ai_settings(bea_id).unwrap(), Default::default());
        // Their session went with them.
        let res = app.get("/api/ai/status", Some(&bea)).await;
        assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    }
}

// ---------------------------------------------------------------- models

#[tokio::test]
async fn the_model_list_is_fetched_filtered_and_cached_for_an_hour() {
    let upstream = Upstream::start().await;
    let app = TestApp::ai(&upstream);
    let admin = app.admin().await;
    let bea = app.join(&admin, "bea@example.org", "member", None).await;
    app.ai_ready(&admin).await;
    upstream.models(Reply::json(json!({
        "data": [
            { "id": "a/with-tools", "name": "With tools", "context_length": 200000,
              "supported_parameters": ["max_tokens", "tools", "tool_choice"],
              "pricing": { "prompt": "0.000003" }, "architecture": { "modality": "text" } },
            { "id": "a/no-tools", "name": "No tools", "context_length": 8000,
              "supported_parameters": ["max_tokens"] },
            { "id": "a/does-not-say", "name": "Does not say" },
            { "id": "a/nameless" },
            { "name": "No id at all" },
            17
        ],
        "something_new": { "x": 1 }
    })));
    let expected = json!({ "models": [
        { "id": "a/with-tools", "name": "With tools", "context_length": 200000 },
        { "id": "a/does-not-say", "name": "Does not say" },
        { "id": "a/nameless", "name": "a/nameless" },
    ] });
    let res = app.get("/api/ai/models", Some(&admin)).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body, expected);
    let seen = upstream.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!(
        (seen[0].method.as_str(), seen[0].path.as_str()),
        ("GET", "/api/v1/models")
    );
    // The list is public: no Member's key goes with the request.
    assert!(!seen[0].headers.contains_key("authorization"));

    // Within the hour it is served from the cache, to anyone, whatever upstream does.
    upstream.models(Reply::status(500, "{}"));
    app.clock.advance(59 * 60 * 1000);
    assert_eq!(app.get("/api/ai/models", Some(&bea)).await.body, expected);
    assert_eq!(app.get("/api/ai/models", Some(&admin)).await.body, expected);
    assert_eq!(upstream.seen().len(), 1);

    // After an hour it is fetched again; a failure is 502 and is not cached.
    app.clock.advance(60 * 1000);
    let res = app.get("/api/ai/models", Some(&admin)).await;
    assert_eq!(res.status, StatusCode::BAD_GATEWAY);
    assert_eq!(res.code(), "upstream_failed");
    assert_eq!(upstream.seen().len(), 2);
    upstream.models(Reply::json(
        json!({ "data": [{ "id": "b/new", "name": "New" }] }),
    ));
    let res = app.get("/api/ai/models", Some(&admin)).await;
    assert_eq!(
        res.body,
        json!({ "models": [{ "id": "b/new", "name": "New" }] })
    );
    assert_eq!(upstream.seen().len(), 3);
}

#[tokio::test]
async fn a_model_list_that_cannot_be_fetched_is_a_502_without_upstream_text() {
    let upstream = Upstream::start().await;
    let elsewhere = Upstream::start().await;
    let app = TestApp::ai(&upstream);
    let admin = app.admin().await;
    let leak = "UPSTREAM-BODY-TEXT";
    for reply in [
        Reply::status(500, &format!("{{\"error\":\"{leak}\"}}")),
        Reply::status(401, &format!("{{\"error\":\"{leak}\"}}")),
        Reply::status(200, &format!("<html>{leak}</html>")),
        Reply::json(json!({ "models": [leak] })),
        Reply::json(json!({ "data": leak })),
        Reply::json(json!([leak])),
        // A redirect is not followed, wherever it points.
        Reply::status(302, "").header("location", &format!("{}/models", elsewhere.url)),
        Reply::status(307, "").header("location", &format!("{}/models", elsewhere.url)),
    ] {
        upstream.models(reply);
        let res = app.get("/api/ai/models", Some(&admin)).await;
        assert_eq!(res.status, StatusCode::BAD_GATEWAY, "{}", res.text);
        assert_eq!(res.code(), "upstream_failed");
        assert!(!res.text.contains(leak), "{}", res.text);
    }
    assert!(elsewhere.seen().is_empty(), "a redirect was followed");

    // Nothing listening at all.
    let closed = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}/api/v1", l.local_addr().unwrap())
    };
    let app = TestApp::with_ai(Arc::new(MemoryStore::new()), &closed);
    let admin = app.admin().await;
    let res = app.get("/api/ai/models", Some(&admin)).await;
    assert_eq!(res.status, StatusCode::BAD_GATEWAY);
}

// ---------------------------------------------------------------- migration

/// The schema a database file had after M6 (`user_version` 3).
const M6_SCHEMA: &str = "
CREATE TABLE members (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    color TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    access_until INTEGER,
    created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX sessions_member ON sessions(member_id);
CREATE TABLE invites (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    access_until INTEGER,
    expires_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    used_at INTEGER
);
CREATE TABLE workspace (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    json TEXT NOT NULL
);
CREATE TABLE todos (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    done INTEGER NOT NULL,
    done_at INTEGER,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    card_id TEXT,
    card_title TEXT,
    card_branch TEXT
);
CREATE INDEX todos_owner ON todos(owner);
CREATE TABLE access_tokens (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
);
CREATE INDEX access_tokens_member ON access_tokens(member_id);
CREATE TABLE suggestions (
    id TEXT PRIMARY KEY,
    branch TEXT NOT NULL,
    kind TEXT NOT NULL,
    card TEXT,
    source_url TEXT,
    source_doi TEXT,
    source_title TEXT,
    source_authors TEXT,
    source_year TEXT,
    conn_from TEXT,
    conn_to TEXT,
    conn_kind TEXT,
    conn_label TEXT,
    reason TEXT NOT NULL,
    created_by TEXT NOT NULL,
    model TEXT,
    created_at INTEGER NOT NULL,
    state TEXT NOT NULL,
    decided_by TEXT,
    decided_at INTEGER
);
CREATE INDEX suggestions_branch ON suggestions(branch, state);
PRAGMA user_version = 3;
";

#[tokio::test]
async fn a_database_file_from_before_m7_upgrades_in_place_and_keeps_its_data() {
    let upstream = Upstream::start().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("infall.db");

    // An M6 file with an account, an access token, a To-do and a Board holding one Card.
    let scratch = MemoryStore::new();
    let ada =
        infall_server::create_admin(&scratch, "admin@example.org", "Ada Admin", PASSWORD, START)
            .unwrap();
    let (mut ws, main) = infall_core::Workspace::new();
    let card = new_id();
    let ops: Vec<infall_core::Op> =
        serde_json::from_value(json!([create_card(&card, "From M6")])).unwrap();
    ws.record_all(main, ada.id, START, ops).unwrap();
    let todo_id = new_id();
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(M6_SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO members (id, email, name, role, color, password_hash, access_until, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                ada.id.0.to_string(),
                ada.email,
                ada.name,
                ada.role.as_str(),
                ada.color,
                ada.password_hash,
                ada.access_until,
                ada.created_at
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO workspace (id, json) VALUES (1, ?1)",
            rusqlite::params![serde_json::to_string(&ws).unwrap()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO todos (id, owner, text, done, created_by, created_at)
             VALUES (?1, ?2, 'Kept from M6', 0, ?2, ?3)",
            rusqlite::params![todo_id, ada.id.0.to_string(), START],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO access_tokens (id, member_id, name, token_hash, created_at)
             VALUES (?1, ?2, 'Kept token', 'hash', ?3)",
            rusqlite::params![new_id(), ada.id.0.to_string(), START],
        )
        .unwrap();
        let new_tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'ai_settings'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(new_tables, 0);
    }
    let version = |path: &std::path::Path| -> i64 {
        rusqlite::Connection::open(path)
            .unwrap()
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(version(&path), 3);

    let secret = SecretKey::generate().unwrap();
    {
        let store: Arc<dyn Store> = Arc::new(SqliteStore::open(&path).unwrap());
        let app = TestApp::with_ai_key(store, &upstream.url, secret.clone());
        let res = app.login("admin@example.org", PASSWORD).await;
        assert_eq!(res.status, StatusCode::OK, "the account is still there");
        let cookie = res.cookie();
        let board = app
            .get(&format!("/api/branches/{}/board", main.0), Some(&cookie))
            .await;
        assert_eq!(
            board.body["entities"][&card]["fields"]["title"],
            json!({ "Text": "From M6" })
        );
        let todos = app.get("/api/todos", Some(&cookie)).await;
        assert_eq!(todos.body["todos"][0]["text"], "Kept from M6");
        let tokens = app.get("/api/tokens", Some(&cookie)).await;
        assert_eq!(tokens.body["tokens"][0]["name"], "Kept token");

        // The new table is there and works.
        assert_eq!(
            app.get("/api/ai/status", Some(&cookie)).await.body,
            json!({ "enabled": true })
        );
        app.ai_ready(&cookie).await;
        assert_eq!(app.chat(&cookie, "hi").await.last()["type"], "done");
    }
    assert_eq!(version(&path), SCHEMA_VERSION);
    assert_eq!(SCHEMA_VERSION, 8);

    // Opening the upgraded file again changes nothing.
    let store: Arc<dyn Store> = Arc::new(SqliteStore::open(&path).unwrap());
    let app = TestApp::with_ai_key(store, &upstream.url, secret);
    let cookie = app.login("admin@example.org", PASSWORD).await.cookie();
    assert_eq!(
        app.get("/api/ai/status", Some(&cookie)).await.body,
        json!({ "enabled": true, "key": { "last4": "TAIL", "added_at": START }, "model": MODEL })
    );
    assert_eq!(
        app.get("/api/todos", Some(&cookie)).await.body["todos"][0]["id"],
        todo_id
    );
    assert_eq!(version(&path), SCHEMA_VERSION);
}

// ---------------------------------------------------------------- the command line

fn server() -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_infall-server"));
    for name in [
        "INFALL_SECRET_KEY",
        "INFALL_OPENROUTER_URL",
        "INFALL_ADDR",
        "INFALL_DB",
    ] {
        cmd.env_remove(name);
    }
    cmd
}

#[test]
fn gen_secret_key_prints_a_fresh_32_byte_key() {
    let mut keys = Vec::new();
    for _ in 0..2 {
        let out = server().arg("gen-secret-key").output().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let text = String::from_utf8(out.stdout).unwrap();
        let key = text.trim();
        assert_eq!(text, format!("{key}\n"), "exactly the key on one line");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(key)
            .unwrap();
        assert_eq!(bytes.len(), 32);
        assert!(SecretKey::from_base64(key).is_ok());
        keys.push(key.to_string());
    }
    assert_ne!(keys[0], keys[1]);

    // It works even while the configured key is the thing that is wrong.
    let out = server()
        .arg("gen-secret-key")
        .env("INFALL_SECRET_KEY", "wrong")
        .output()
        .unwrap();
    assert!(out.status.success());
}

#[test]
fn a_secret_key_of_the_wrong_length_stops_the_server_at_startup() {
    let dir = tempfile::tempdir().unwrap();
    let short = base64::engine::general_purpose::STANDARD.encode([9u8; 16]);
    for (bad, says) in [(short.as_str(), "32 bytes"), ("not/base64!!", "base64")] {
        let out = server()
            .arg("serve")
            .env("INFALL_SECRET_KEY", bad)
            .env("INFALL_ADDR", "127.0.0.1:0")
            .env("INFALL_DB", dir.path().join("infall.db"))
            .output()
            .unwrap();
        assert!(!out.status.success());
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(err.contains("INFALL_SECRET_KEY"), "{err}");
        assert!(err.contains(says), "{err}");
        assert!(err.contains("gen-secret-key"), "{err}");
        assert!(!err.contains(bad), "the value was printed: {err}");
        assert!(
            !dir.path().join("infall.db").exists(),
            "it got as far as the database"
        );
    }
    let out = server()
        .arg("serve")
        .env("INFALL_OPENROUTER_URL", "openrouter.ai/api/v1")
        .env("INFALL_ADDR", "127.0.0.1:0")
        .env("INFALL_DB", dir.path().join("infall.db"))
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("INFALL_OPENROUTER_URL"));
}
