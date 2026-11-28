mod common;

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use common::*;
use infall_server::auth::token_hash;
use infall_server::store::MemoryStore;
use infall_server::{AccountError, create_admin, reset_password};
use serde_json::json;

#[tokio::test]
async fn health_is_public_and_says_only_ok_and_the_version() {
    let app = TestApp::new();
    let res = app.get("/api/health", None).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(
        res.body,
        json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") })
    );
}

#[tokio::test]
async fn create_admin_then_login_then_me() {
    let app = TestApp::new();
    let cookie = app.admin().await;
    let me = app.get("/api/me", Some(&cookie)).await;
    assert_eq!(me.status, StatusCode::OK);
    let m = &me.body["member"];
    assert_eq!(m["name"], "Ada Admin");
    assert_eq!(m["role"], "admin");
    assert_eq!(m["email"], "admin@example.org");
    assert_eq!(m["color"], "oklch(0.76 0.08 35)");
    assert!(m.get("access_until").is_none());
    assert!(!me.text.contains("argon2"), "no hash in responses");
    assert!(
        me.headers[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("application/json")
    );
}

#[tokio::test]
async fn login_compares_email_case_insensitively() {
    let app = TestApp::new();
    app.admin().await;
    let res = app.login("  ADMIN@Example.org ", PASSWORD).await;
    assert_eq!(res.status, StatusCode::OK);
}

#[tokio::test]
async fn me_without_a_session_is_not_signed_in() {
    let app = TestApp::new();
    let res = app.get("/api/me", None).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    assert_eq!(res.code(), "not_signed_in");
    let res = app.get("/api/me", Some("infall_session=made-up")).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn wrong_password_and_unknown_email_get_the_same_401() {
    let app = TestApp::new();
    app.admin().await;
    let wrong = app
        .login("admin@example.org", "not the password at all")
        .await;
    let unknown = app.login("nobody@example.org", PASSWORD).await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
    assert_eq!(unknown.status, StatusCode::UNAUTHORIZED);
    assert_eq!(wrong.body, unknown.body);
    assert_eq!(wrong.code(), "bad_credentials");
    assert!(wrong.set_cookie().is_none());
    assert!(!wrong.text.contains("not the password"));
}

#[tokio::test]
async fn login_is_throttled_after_five_failures_for_fifteen_minutes() {
    let app = TestApp::new();
    app.admin().await;
    for _ in 0..5 {
        let res = app.login("admin@example.org", "wrong wrong wrong").await;
        assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    }
    // Even the right password is refused while throttled.
    let res = app.login("admin@example.org", PASSWORD).await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(res.code(), "too_many_attempts");
    // Unknown emails are throttled the same way, so the 429 reveals nothing.
    for _ in 0..5 {
        app.login("ghost@example.org", "wrong wrong wrong").await;
    }
    assert_eq!(
        app.login("ghost@example.org", PASSWORD).await.status,
        StatusCode::TOO_MANY_REQUESTS
    );
    app.clock.advance(15 * 60 * 1000 + 1);
    let res = app.login("admin@example.org", PASSWORD).await;
    assert_eq!(res.status, StatusCode::OK);
}

#[tokio::test]
async fn writes_need_the_request_header_and_an_allowed_origin() {
    let app = TestApp::new();
    app.admin().await;
    let body = json!({ "email": "admin@example.org", "password": PASSWORD }).to_string();
    let attempt = |origin: Option<&'static str>, marker: bool| {
        let mut b = Request::builder()
            .method(Method::POST)
            .uri("/api/auth/login")
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(o) = origin {
            b = b.header(header::ORIGIN, o);
        }
        if marker {
            b = b.header("x-infall-request", "1");
        }
        b.body(Body::from(body.clone())).unwrap()
    };
    for (origin, marker) in [
        (Some(ORIGIN), false),
        (None, true),
        (Some("https://evil.example"), true),
        (Some("null"), true),
        (Some("http://localhost:8787.evil.example"), true),
    ] {
        let res = app.send(attempt(origin, marker)).await;
        assert_eq!(res.status, StatusCode::FORBIDDEN, "{origin:?} {marker}");
        assert_eq!(res.code(), "forbidden_origin");
        assert!(res.set_cookie().is_none());
    }
    assert_eq!(
        app.send(attempt(Some(ORIGIN), true)).await.status,
        StatusCode::OK
    );
    // The guard runs before routing too: an unknown write route is still 403.
    let res = app
        .send(
            Request::builder()
                .method(Method::DELETE)
                .uri("/api/members/x")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(res.code(), "forbidden_origin");
}

#[tokio::test]
async fn the_dev_origin_is_allowed_when_configured() {
    let app = TestApp::with_config(Arc::new(MemoryStore::new()), |c| {
        c.dev_origin = Some("http://localhost:5173".to_string());
    });
    app.admin().await;
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/auth/login")
        .header(header::ORIGIN, "http://localhost:5173")
        .header("x-infall-request", "1")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({ "email": "admin@example.org", "password": PASSWORD }).to_string(),
        ))
        .unwrap();
    assert_eq!(app.send(req).await.status, StatusCode::OK);
}

#[tokio::test]
async fn the_session_cookie_has_exactly_the_contract_attributes() {
    let app = TestApp::new();
    app.admin().await;
    let res = app.login("admin@example.org", PASSWORD).await;
    let set = res.set_cookie().unwrap();
    let token = res
        .cookie()
        .trim_start_matches("infall_session=")
        .to_string();
    assert_eq!(
        set,
        format!("infall_session={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000")
    );
    // 32 bytes, URL-safe base64 without padding.
    assert_eq!(token.len(), 43);
    assert!(
        token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    );
    // Only the hash is stored.
    assert!(app.store.session(&token, START).unwrap().is_none());
    assert!(
        app.store
            .session(&token_hash(&token), START)
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn the_cookie_is_secure_when_the_public_origin_is_https() {
    let app = TestApp::with_config(Arc::new(MemoryStore::new()), |c| {
        c.public_origin = "https://infall.example.org".to_string();
    });
    create_admin(&*app.store, "admin@example.org", "Ada", PASSWORD, START).unwrap();
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/auth/login")
        .header(header::ORIGIN, "https://infall.example.org")
        .header("x-infall-request", "1")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({ "email": "admin@example.org", "password": PASSWORD }).to_string(),
        ))
        .unwrap();
    let res = app.send(req).await;
    assert_eq!(res.status, StatusCode::OK);
    assert!(res.set_cookie().unwrap().ends_with("; Secure"));
}

#[tokio::test]
async fn logout_deletes_the_server_side_session_and_clears_the_cookie() {
    let app = TestApp::new();
    let cookie = app.admin().await;
    let res = app
        .post("/api/auth/logout", Some(&cookie), json!(null))
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body, json!({}));
    let set = res.set_cookie().unwrap();
    assert!(
        set.starts_with("infall_session=;") && set.contains("Max-Age=0"),
        "{set}"
    );
    // Replaying the old cookie no longer works.
    assert_eq!(
        app.get("/api/me", Some(&cookie)).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn sessions_slide_and_expire_after_thirty_idle_days() {
    let app = TestApp::new();
    let cookie = app.admin().await;
    app.clock.advance(20 * 24 * 3600 * 1000);
    let res = app.get("/api/me", Some(&cookie)).await;
    assert_eq!(res.status, StatusCode::OK);
    assert!(
        res.set_cookie().unwrap().contains("Max-Age=2592000"),
        "the cookie is re-sent"
    );
    app.clock.advance(20 * 24 * 3600 * 1000);
    assert_eq!(
        app.get("/api/me", Some(&cookie)).await.status,
        StatusCode::OK
    );
    app.clock.advance(31 * 24 * 3600 * 1000);
    assert_eq!(
        app.get("/api/me", Some(&cookie)).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn malformed_json_is_a_400_in_the_contract_shape() {
    let app = TestApp::new();
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/auth/login")
        .header(header::ORIGIN, ORIGIN)
        .header("x-infall-request", "1")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{ not json"))
        .unwrap();
    let res = app.send(req).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.code(), "bad_request");
    assert!(res.body["error"]["message"].is_string());
    assert!(res.body["error"]["detail"].is_null());
    let res = app
        .post("/api/auth/login", None, json!({ "email": 5 }))
        .await;
    assert_eq!(res.code(), "bad_request");
}

#[tokio::test]
async fn bodies_over_one_megabyte_are_refused() {
    let app = TestApp::new();
    let big = "x".repeat(1024 * 1024 + 10);
    let res = app
        .post(
            "/api/auth/login",
            None,
            json!({ "email": big, "password": "p" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.code(), "bad_request");
}

#[tokio::test]
async fn sql_metacharacters_in_input_are_just_data() {
    let store = Arc::new(infall_server::store::SqliteStore::open_in_memory().unwrap());
    let app = TestApp::with_store(store);
    app.admin().await;
    let res = app.login("' OR '1'='1", "' OR '1'='1' --").await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    let res = app.login("admin@example.org' --", PASSWORD).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
}

#[test]
fn create_admin_enforces_password_length_and_unique_email() {
    let store = MemoryStore::new();
    assert!(matches!(
        create_admin(&store, "a@example.org", "A", "short pass", START),
        Err(AccountError::Invalid(_))
    ));
    let m = create_admin(&store, " A@Example.org ", "A", PASSWORD, START).unwrap();
    assert_eq!(m.email.as_deref(), Some("a@example.org"));
    assert!(m.password_hash.starts_with("$argon2id$"));
    assert!(!m.password_hash.contains(PASSWORD));
    assert!(matches!(
        create_admin(&store, "a@example.org", "B", PASSWORD, START),
        Err(AccountError::EmailTaken(_))
    ));
}

#[tokio::test]
async fn reset_password_ends_sessions_and_swaps_the_password() {
    let app = TestApp::new();
    let cookie = app.admin().await;
    let new_password = "a brand new password";
    assert!(matches!(
        reset_password(&*app.store, "admin@example.org", "too short"),
        Err(AccountError::Invalid(_))
    ));
    assert!(matches!(
        reset_password(&*app.store, "nobody@example.org", new_password),
        Err(AccountError::UnknownEmail(_))
    ));
    reset_password(&*app.store, "ADMIN@example.org", new_password).unwrap();
    assert_eq!(
        app.get("/api/me", Some(&cookie)).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        app.login("admin@example.org", PASSWORD).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        app.login("admin@example.org", new_password).await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn every_response_carries_the_security_headers() {
    let app = TestApp::new();
    for res in [
        app.get("/api/me", None).await,
        app.get("/api/health", None).await,
        app.get("/", None).await,
    ] {
        assert_eq!(res.headers["x-content-type-options"], "nosniff");
        assert_eq!(res.headers["referrer-policy"], "same-origin");
    }
    assert!(
        app.get("/api/health", None)
            .await
            .headers
            .get("content-security-policy")
            .is_none()
    );
    let html = app.get("/", None).await;
    assert!(
        html.headers["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("frame-ancestors 'none'")
    );
}
