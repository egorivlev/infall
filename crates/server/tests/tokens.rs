mod common;

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use common::*;
use qoop_server::reset_password;
use qoop_server::store::{MemoryStore, SqliteStore, Store};
use serde_json::{Value, json};

fn stores() -> Vec<Arc<dyn Store>> {
    vec![
        Arc::new(MemoryStore::new()),
        Arc::new(SqliteStore::open_in_memory().unwrap()),
    ]
}

async fn member_id(app: &TestApp, cookie: &str) -> String {
    app.get("/api/me", Some(cookie)).await.body["member"]["id"]
        .as_str()
        .unwrap()
        .to_string()
}

async fn ping(app: &TestApp, bearer: &str) -> Res {
    app.rpc(bearer, "ping", json!({})).await
}

fn sha256_hex(s: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

// ---------------------------------------------------------------- CRUD

#[tokio::test]
async fn a_token_is_created_listed_and_deleted_by_its_owner_only() {
    for store in stores() {
        let app = TestApp::with_store(store);
        let admin = app.admin().await;
        let bea = app.join(&admin, "bea@example.org", "member", None).await;
        assert_eq!(
            app.get("/api/tokens", Some(&admin)).await.body,
            json!({ "tokens": [] })
        );

        let res = app
            .post(
                "/api/tokens",
                Some(&admin),
                json!({ "name": "  Claude desktop " }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        let secret = res.body["secret"].as_str().unwrap().to_string();
        let id = res.body["token"]["id"].as_str().unwrap().to_string();
        assert_eq!(
            res.body["token"],
            json!({ "id": id, "name": "Claude desktop", "created_at": START })
        );
        // `qoop_pat_` + 43 url-safe base64 characters (32 random bytes).
        let tail = secret.strip_prefix("qoop_pat_").expect("the prefix");
        assert_eq!(tail.len(), 43);
        assert!(
            tail.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        );

        app.clock.advance(1_000);
        let second = app
            .post("/api/tokens", Some(&admin), json!({ "name": "Second" }))
            .await;
        assert_ne!(second.body["secret"], secret);
        let second_id = second.body["token"]["id"].as_str().unwrap().to_string();
        let beas = app
            .post("/api/tokens", Some(&bea), json!({ "name": "Bea's" }))
            .await;
        let beas_id = beas.body["token"]["id"].as_str().unwrap().to_string();

        // Own tokens only, oldest first.
        let list = app.get("/api/tokens", Some(&admin)).await;
        assert_eq!(
            list.body,
            json!({ "tokens": [
                { "id": id, "name": "Claude desktop", "created_at": START },
                { "id": second_id, "name": "Second", "created_at": START + 1_000 },
            ] })
        );
        assert_eq!(
            app.get("/api/tokens", Some(&bea)).await.body["tokens"],
            json!([{ "id": beas_id, "name": "Bea's", "created_at": START + 1_000 }])
        );

        // Someone else's token, an unknown id and a non-id are all 404.
        for path in [
            format!("/api/tokens/{beas_id}"),
            format!("/api/tokens/{}", new_id()),
            "/api/tokens/nope".to_string(),
        ] {
            let res = app.delete(&path, Some(&admin)).await;
            assert_eq!(res.status, StatusCode::NOT_FOUND, "{path}");
        }
        assert_eq!(
            ping(&app, beas.body["secret"].as_str().unwrap())
                .await
                .status,
            StatusCode::OK
        );

        let res = app.delete(&format!("/api/tokens/{id}"), Some(&admin)).await;
        assert_eq!(res.status, StatusCode::OK);
        assert_eq!(res.body, json!({}));
        let again = app.delete(&format!("/api/tokens/{id}"), Some(&admin)).await;
        assert_eq!(again.status, StatusCode::NOT_FOUND);
        assert_eq!(
            app.get("/api/tokens", Some(&admin)).await.body["tokens"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
}

#[tokio::test]
async fn token_names_are_one_to_sixty_characters_on_one_line() {
    let app = TestApp::new();
    let admin = app.admin().await;
    for bad in [
        json!({ "name": "" }),
        json!({ "name": "   " }),
        json!({ "name": "x".repeat(61) }),
        json!({ "name": "two\nlines" }),
        json!({ "name": 5 }),
        json!({}),
    ] {
        let res = app.post("/api/tokens", Some(&admin), bad.clone()).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{bad}");
        assert_eq!(res.code(), "bad_request");
    }
    let res = app
        .post(
            "/api/tokens",
            Some(&admin),
            json!({ "name": "é".repeat(60) }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
}

#[tokio::test]
async fn a_member_has_at_most_ten_tokens() {
    for store in stores() {
        let app = TestApp::with_store(store);
        let admin = app.admin().await;
        let bea = app.join(&admin, "bea@example.org", "member", None).await;
        let mut ids = Vec::new();
        for i in 0..10 {
            let res = app
                .post(
                    "/api/tokens",
                    Some(&admin),
                    json!({ "name": format!("t{i}") }),
                )
                .await;
            assert_eq!(res.status, StatusCode::OK, "{}", res.text);
            ids.push(res.body["token"]["id"].as_str().unwrap().to_string());
        }
        let res = app
            .post("/api/tokens", Some(&admin), json!({ "name": "eleventh" }))
            .await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST);
        assert_eq!(res.code(), "bad_request");
        assert!(res.body.get("secret").is_none());
        assert_eq!(
            app.get("/api/tokens", Some(&admin)).await.body["tokens"]
                .as_array()
                .unwrap()
                .len(),
            10
        );
        // The limit is per Member.
        app.access_token(&bea, "bea's first").await;
        // Deleting one makes room again.
        app.delete(&format!("/api/tokens/{}", ids[3]), Some(&admin))
            .await;
        app.access_token(&admin, "eleventh").await;
    }
}

#[tokio::test]
async fn guests_and_strangers_cannot_touch_tokens() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let guest = app
        .join(&admin, "gus@example.org", "guest", Some(START + 1_000_000))
        .await;
    let secret = app.access_token(&admin, "mine").await;
    let id = app.get("/api/tokens", Some(&admin)).await.body["tokens"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    for (who, status, code) in [
        (Some(guest.as_str()), StatusCode::FORBIDDEN, "forbidden"),
        (None, StatusCode::UNAUTHORIZED, "not_signed_in"),
    ] {
        let list = app.get("/api/tokens", who).await;
        assert_eq!((list.status, list.code()), (status, code));
        let made = app.post("/api/tokens", who, json!({ "name": "x" })).await;
        assert_eq!((made.status, made.code()), (status, code));
        assert!(!made.text.contains("qoop_pat_"));
        let gone = app.delete(&format!("/api/tokens/{id}"), who).await;
        assert_eq!((gone.status, gone.code()), (status, code));
    }
    assert_eq!(ping(&app, &secret).await.status, StatusCode::OK);

    // Creating a token is a write like any other: it needs the Origin and the marker.
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/tokens")
        .header(header::COOKIE, &admin)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "name": "x" }).to_string()))
        .unwrap();
    let res = app.send(req).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.code(), "forbidden_origin");
}

// ---------------------------------------------------------------- where each credential works

#[tokio::test]
async fn a_session_cookie_alone_gets_401_on_the_tool_endpoint() {
    let app = TestApp::new();
    let admin = app.admin().await;
    app.access_token(&admin, "exists").await;
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }).to_string();
    let session = admin.strip_prefix("qoop_session=").unwrap().to_string();

    let with = |headers: Vec<(header::HeaderName, String)>| {
        let mut b = Request::builder()
            .method(Method::POST)
            .uri("/mcp")
            .header(header::CONTENT_TYPE, "application/json");
        for (k, v) in headers {
            b = b.header(k, v);
        }
        b.body(Body::from(body.clone())).unwrap()
    };
    let cases = vec![
        // Nothing at all.
        vec![],
        // The session cookie, as a browser would send it (with and without the UI's headers).
        vec![(header::COOKIE, admin.clone())],
        vec![
            (header::COOKIE, admin.clone()),
            (header::ORIGIN, ORIGIN.to_string()),
            (
                header::HeaderName::from_static("x-qoop-request"),
                "1".to_string(),
            ),
        ],
        // The session token dressed up as a bearer token.
        vec![(header::AUTHORIZATION, format!("Bearer {session}"))],
        vec![(header::AUTHORIZATION, format!("Bearer qoop_pat_{session}"))],
        // Unknown and malformed credentials.
        vec![(
            header::AUTHORIZATION,
            format!("Bearer qoop_pat_{}", "A".repeat(43)),
        )],
        vec![(header::AUTHORIZATION, "Bearer".to_string())],
        vec![(header::AUTHORIZATION, "Bearer ".to_string())],
        vec![(header::AUTHORIZATION, "Basic YWRtaW46YWRtaW4=".to_string())],
    ];
    for headers in cases {
        let shown = format!("{headers:?}");
        let res = app.send(with(headers)).await;
        assert_eq!(res.status, StatusCode::UNAUTHORIZED, "{shown}");
        assert_eq!(
            res.headers.get(header::WWW_AUTHENTICATE).unwrap(),
            "Bearer",
            "{shown}"
        );
        assert_eq!(res.code(), "not_signed_in");
        assert!(res.body.get("result").is_none());
    }
}

#[tokio::test]
async fn a_bearer_token_gets_401_on_every_api_route() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let main = app.main_branch(&admin).await;
    let secret = app.access_token(&admin, "mine").await;
    let token_id = app.get("/api/tokens", Some(&admin)).await.body["tokens"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(ping(&app, &secret).await.status, StatusCode::OK);
    let before = app.workspace_bytes();
    let any = new_id();

    let routes: Vec<(Method, String, Value)> = vec![
        (Method::GET, "/api/me".into(), Value::Null),
        (Method::GET, "/api/members".into(), Value::Null),
        (Method::DELETE, format!("/api/members/{any}"), Value::Null),
        (Method::GET, "/api/invites".into(), Value::Null),
        (
            Method::POST,
            "/api/invites".into(),
            json!({ "email": "x@example.org", "role": "member" }),
        ),
        (Method::DELETE, format!("/api/invites/{any}"), Value::Null),
        (Method::POST, "/api/auth/logout".into(), Value::Null),
        (Method::GET, "/api/branches".into(), Value::Null),
        (
            Method::POST,
            "/api/branches".into(),
            json!({ "name": "x", "from": { "branch": main, "seq": 0 } }),
        ),
        (
            Method::GET,
            format!("/api/branches/{main}/board"),
            Value::Null,
        ),
        (
            Method::GET,
            format!("/api/branches/{main}/changes"),
            Value::Null,
        ),
        (
            Method::POST,
            format!("/api/branches/{main}/ops"),
            json!({ "ops": [create_card(&any, "By token")] }),
        ),
        (
            Method::GET,
            format!("/api/branches/{main}/checkpoints"),
            Value::Null,
        ),
        (
            Method::POST,
            format!("/api/branches/{main}/checkpoints"),
            json!({ "name": "x" }),
        ),
        (
            Method::POST,
            format!("/api/branches/{main}/restore"),
            json!({ "to_seq": 0 }),
        ),
        (
            Method::GET,
            format!("/api/merges/plan?source={main}&target={main}"),
            Value::Null,
        ),
        (Method::POST, "/api/merges".into(), json!({})),
        (Method::GET, "/api/todos".into(), Value::Null),
        (
            Method::POST,
            "/api/todos".into(),
            json!({ "owner": any, "text": "x" }),
        ),
        (
            Method::PATCH,
            format!("/api/todos/{any}"),
            json!({ "done": true }),
        ),
        (Method::DELETE, format!("/api/todos/{any}"), Value::Null),
        (Method::GET, "/api/tokens".into(), Value::Null),
        (
            Method::POST,
            "/api/tokens".into(),
            json!({ "name": "more" }),
        ),
        (
            Method::DELETE,
            format!("/api/tokens/{token_id}"),
            Value::Null,
        ),
        (
            Method::GET,
            format!("/api/suggestions?branch={main}"),
            Value::Null,
        ),
        (
            Method::POST,
            format!("/api/suggestions/{any}/accept"),
            json!({ "ops": [create_card(&any, "By token")] }),
        ),
        (
            Method::POST,
            format!("/api/suggestions/{any}/reject"),
            Value::Null,
        ),
        (
            Method::POST,
            format!("/api/suggestions/{any}/reopen"),
            Value::Null,
        ),
        (Method::GET, "/api/ws".into(), Value::Null),
    ];
    for (method, path, body) in routes {
        // As a bearer token, and smuggled in as the session cookie; with everything else a
        // legitimate UI request carries.
        for credential in [
            (header::AUTHORIZATION, format!("Bearer {secret}")),
            (header::COOKIE, format!("qoop_session={secret}")),
        ] {
            let req = Request::builder()
                .method(method.clone())
                .uri(&path)
                .header(header::ORIGIN, ORIGIN)
                .header("x-qoop-request", "1")
                .header(header::CONTENT_TYPE, "application/json")
                .header(credential.0.clone(), credential.1)
                .body(Body::from(body.to_string()))
                .unwrap();
            let res = app.send(req).await;
            assert_eq!(
                res.status,
                StatusCode::UNAUTHORIZED,
                "{method} {path} via {}: {}",
                credential.0,
                res.text
            );
            assert_eq!(res.code(), "not_signed_in", "{method} {path}");
        }
    }
    // Nothing happened: the Workspace and the token list are as they were.
    assert_eq!(app.workspace_bytes(), before);
    assert_eq!(
        app.get("/api/tokens", Some(&admin)).await.body["tokens"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

// ---------------------------------------------------------------- when a token stops working

#[tokio::test]
async fn a_revoked_token_stops_working() {
    for store in stores() {
        let app = TestApp::with_store(store);
        let admin = app.admin().await;
        let keep = app.access_token(&admin, "keep").await;
        let res = app
            .post("/api/tokens", Some(&admin), json!({ "name": "revoke" }))
            .await;
        let secret = res.body["secret"].as_str().unwrap().to_string();
        let id = res.body["token"]["id"].as_str().unwrap();
        assert_eq!(ping(&app, &secret).await.status, StatusCode::OK);

        let gone = app.delete(&format!("/api/tokens/{id}"), Some(&admin)).await;
        assert_eq!(gone.status, StatusCode::OK);
        let res = ping(&app, &secret).await;
        assert_eq!(res.status, StatusCode::UNAUTHORIZED);
        assert_eq!(res.headers.get(header::WWW_AUTHENTICATE).unwrap(), "Bearer");
        let res = app.tool(&keep, "list_branches", json!({})).await;
        assert!(!res.is_error);
        let res = app
            .rpc(&secret, "tools/call", json!({ "name": "list_branches" }))
            .await;
        assert_eq!(res.status, StatusCode::UNAUTHORIZED);
        assert!(res.body.get("result").is_none());
    }
}

#[tokio::test]
async fn a_removed_members_token_stops_working() {
    for store in stores() {
        let app = TestApp::with_store(store);
        let admin = app.admin().await;
        let bea = app.join(&admin, "bea@example.org", "member", None).await;
        let bea_id = member_id(&app, &bea).await;
        let beas = app.access_token(&bea, "bea").await;
        let admins = app.access_token(&admin, "admin").await;
        assert_eq!(ping(&app, &beas).await.status, StatusCode::OK);

        let res = app
            .delete(&format!("/api/members/{bea_id}"), Some(&admin))
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        assert_eq!(ping(&app, &beas).await.status, StatusCode::UNAUTHORIZED);
        assert_eq!(ping(&app, &admins).await.status, StatusCode::OK);
        assert!(
            app.store
                .access_token_by_hash(&sha256_hex(&beas))
                .unwrap()
                .is_none(),
            "the token row is gone, not only unusable"
        );
    }
}

#[tokio::test]
async fn reset_password_revokes_that_members_tokens() {
    for store in stores() {
        let app = TestApp::with_store(store);
        let admin = app.admin().await;
        let bea = app.join(&admin, "bea@example.org", "member", None).await;
        let admins = app.access_token(&admin, "admin").await;
        let beas = app.access_token(&bea, "bea").await;
        assert_eq!(ping(&app, &admins).await.status, StatusCode::OK);

        reset_password(&*app.store, "admin@example.org", "a brand new password").unwrap();
        assert_eq!(ping(&app, &admins).await.status, StatusCode::UNAUTHORIZED);
        assert_eq!(ping(&app, &beas).await.status, StatusCode::OK);

        // Signing in again does not bring the old token back.
        let cookie = app
            .login("admin@example.org", "a brand new password")
            .await
            .cookie();
        assert_eq!(
            app.get("/api/tokens", Some(&cookie)).await.body,
            json!({ "tokens": [] })
        );
        assert_eq!(ping(&app, &admins).await.status, StatusCode::UNAUTHORIZED);
    }
}

#[tokio::test]
async fn a_guests_expiry_or_a_token_row_for_a_guest_never_authenticates() {
    // No route gives a Guest a token; if a row existed anyway it would still be refused.
    let app = TestApp::new();
    let admin = app.admin().await;
    let guest = app
        .join(&admin, "gus@example.org", "guest", Some(START + 1_000_000))
        .await;
    let guest_id = member_id(&app, &guest).await;
    let secret = format!("qoop_pat_{}", "g".repeat(43));
    let stored = app
        .store
        .insert_access_token(
            &qoop_server::store::AccessTokenRecord {
                id: uuid::Uuid::new_v4(),
                member: qoop_core::MemberId(guest_id.parse().unwrap()),
                name: "forged".into(),
                token_hash: sha256_hex(&secret),
                created_at: START,
                last_used_at: None,
            },
            10,
        )
        .unwrap();
    assert!(stored);
    assert_eq!(ping(&app, &secret).await.status, StatusCode::UNAUTHORIZED);
}

// ---------------------------------------------------------------- the secret stays secret

#[tokio::test]
async fn the_secret_appears_only_in_the_response_that_created_it() {
    for store in stores() {
        let app = TestApp::with_store(store);
        let admin = app.admin().await;
        let bea = app.join(&admin, "bea@example.org", "member", None).await;
        let main = app.main_branch(&admin).await;
        let secret = app.access_token(&admin, "mine").await;
        let hash = sha256_hex(&secret);
        let tail = secret.strip_prefix("qoop_pat_").unwrap();
        // Only the hash is stored.
        let (stored, _) = app.store.access_token_by_hash(&hash).unwrap().unwrap();
        assert_eq!(stored.token_hash, hash);
        assert!(!format!("{stored:?}").contains(tail));

        let mut seen = Vec::new();
        for cookie in [&admin, &bea] {
            for path in [
                "/api/tokens".to_string(),
                "/api/me".to_string(),
                "/api/members".to_string(),
                format!("/api/suggestions?branch={main}"),
            ] {
                seen.push(app.get(&path, Some(cookie)).await.text);
            }
        }
        seen.push(app.rpc(&secret, "initialize", json!({})).await.text);
        seen.push(app.rpc(&secret, "tools/list", json!({})).await.text);
        seen.push(app.rpc(&secret, "nope", json!({})).await.text);
        seen.push(app.mcp_raw(Some(&secret), "{not json".into()).await.text);
        seen.push(app.tool(&secret, "list_cards", json!({})).await.text);
        seen.push(
            app.tool(&secret, "list_cards", json!({ "branch": 7 }))
                .await
                .text,
        );
        // A near miss is refused without echoing what was sent.
        let near = format!("{}x", &secret[..secret.len() - 1]);
        let res = ping(&app, &near).await;
        assert_eq!(res.status, StatusCode::UNAUTHORIZED);
        seen.push(res.text);
        seen.push(format!("{:?}", res.headers));
        let wrong_place = app
            .post("/api/tokens", Some(&bea), json!({ "name": "other" }))
            .await;
        assert_ne!(wrong_place.body["secret"], secret);
        seen.push(wrong_place.text);
        for text in seen {
            assert!(!text.contains(tail), "the secret leaked: {text}");
            assert!(!text.contains(&near[9..]), "a guess was echoed: {text}");
            assert!(!text.contains(&hash), "the hash leaked: {text}");
        }
    }
}

// ---------------------------------------------------------------- Origin

#[tokio::test]
async fn the_tool_endpoint_checks_an_origin_only_when_one_is_sent() {
    let app = TestApp::with_config(Arc::new(MemoryStore::new()), |c| {
        c.dev_origin = Some("http://localhost:5173".to_string());
    });
    let admin = app.admin().await;
    let secret = app.access_token(&admin, "mine").await;
    let send = |origin: Option<&'static str>, bearer: bool| {
        let mut b = Request::builder()
            .method(Method::POST)
            .uri("/mcp")
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(o) = origin {
            b = b.header(header::ORIGIN, o);
        }
        if bearer {
            b = b.header(header::AUTHORIZATION, format!("Bearer {secret}"));
        }
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }).to_string();
        app.send(b.body(Body::from(body)).unwrap())
    };

    // No Origin (a non-browser client), and no `X-Qoop-Request` either: works.
    let res = send(None, true).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body, json!({ "jsonrpc": "2.0", "id": 1, "result": {} }));
    // Our own origins: fine.
    assert_eq!(send(Some(ORIGIN), true).await.status, StatusCode::OK);
    assert_eq!(
        send(Some("http://localhost:5173"), true).await.status,
        StatusCode::OK
    );
    // Any other: refused even with a valid token, and before the token is looked at.
    for foreign in [
        "https://evil.example",
        "null",
        "http://localhost:8787.evil.example",
        "http://localhost:9999",
    ] {
        for bearer in [true, false] {
            let res = send(Some(foreign), bearer).await;
            assert_eq!(res.status, StatusCode::FORBIDDEN, "{foreign}");
            assert_eq!(res.code(), "forbidden_origin");
        }
    }
    // The rest of the API still needs the marker header on writes.
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/auth/logout")
        .header(header::COOKIE, &admin)
        .body(Body::empty())
        .unwrap();
    assert_eq!(app.send(req).await.code(), "forbidden_origin");
}

#[tokio::test]
async fn get_and_delete_on_the_tool_endpoint_are_405() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let secret = app.access_token(&admin, "mine").await;
    for method in [Method::GET, Method::DELETE, Method::PUT, Method::PATCH] {
        for bearer in [true, false] {
            let mut b = Request::builder().method(method.clone()).uri("/mcp");
            if bearer {
                b = b.header(header::AUTHORIZATION, format!("Bearer {secret}"));
            }
            let res = app.send(b.body(Body::empty()).unwrap()).await;
            assert_eq!(res.status, StatusCode::METHOD_NOT_ALLOWED, "{method}");
            assert_eq!(res.headers.get(header::ALLOW).unwrap(), "POST");
            assert_eq!(res.code(), "method_not_allowed");
            assert_eq!(
                res.headers.get("x-content-type-options").unwrap(),
                "nosniff"
            );
        }
    }
}

// ---------------------------------------------------------------- rate limit and last use

#[tokio::test]
async fn a_token_gets_120_requests_a_minute() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let secret = app.access_token(&admin, "busy").await;
    let other = app.access_token(&admin, "quiet").await;
    for i in 0..120 {
        let res = ping(&app, &secret).await;
        assert_eq!(res.status, StatusCode::OK, "request {i}");
        app.clock.advance(100);
    }
    let res = ping(&app, &secret).await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(res.code(), "too_many_requests");
    assert!(res.body.get("result").is_none());
    // Also for tool calls and for bodies that would not parse; nothing is run.
    let res = app
        .rpc(&secret, "tools/call", json!({ "name": "list_branches" }))
        .await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS);
    let res = app.mcp_raw(Some(&secret), "{".into()).await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS);
    // Per token, not per Member.
    assert_eq!(ping(&app, &other).await.status, StatusCode::OK);
    // An unknown token is 401, never 429.
    assert_eq!(
        ping(&app, "qoop_pat_nope").await.status,
        StatusCode::UNAUTHORIZED
    );

    // Just under a minute after the first request the window still holds all 120; a
    // minute after it, one has left.
    app.clock.advance(47_999);
    assert_eq!(
        ping(&app, &secret).await.status,
        StatusCode::TOO_MANY_REQUESTS
    );
    app.clock.advance(1);
    assert_eq!(ping(&app, &secret).await.status, StatusCode::OK);
    assert_eq!(
        ping(&app, &secret).await.status,
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[tokio::test]
async fn last_used_at_is_updated_at_most_once_a_minute() {
    for store in stores() {
        let app = TestApp::with_store(store);
        let admin = app.admin().await;
        let secret = app.access_token(&admin, "mine").await;
        let last_used = || async {
            app.get("/api/tokens", Some(&admin)).await.body["tokens"][0]
                .get("last_used_at")
                .cloned()
        };
        assert_eq!(last_used().await, None);

        app.clock.advance(5_000);
        ping(&app, &secret).await;
        assert_eq!(last_used().await, Some(json!(START + 5_000)));
        app.clock.advance(59_999);
        ping(&app, &secret).await;
        assert_eq!(last_used().await, Some(json!(START + 5_000)));
        app.clock.advance(1);
        ping(&app, &secret).await;
        assert_eq!(last_used().await, Some(json!(START + 65_000)));
        // A refused request does not count as use.
        app.clock.advance(120_000);
        ping(&app, &format!("{secret}x")).await;
        assert_eq!(last_used().await, Some(json!(START + 65_000)));
    }
}
