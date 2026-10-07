//! `GET /visual-frame` (contract §13): the page a Visual runs in, and its headers.

mod common;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use common::*;

const FRAME_CSP: &str = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

fn header_values(res: &Res, name: header::HeaderName) -> Vec<String> {
    res.headers
        .get_all(name)
        .iter()
        .map(|v| v.to_str().unwrap().to_string())
        .collect()
}

/// The frame's headers, each exactly once and exactly as the contract has them.
fn assert_frame_headers(res: &Res) {
    for (name, value) in [
        (header::CONTENT_SECURITY_POLICY, FRAME_CSP),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::REFERRER_POLICY, "no-referrer"),
        (header::CACHE_CONTROL, "no-cache"),
        (header::CONTENT_TYPE, "text/html; charset=utf-8"),
    ] {
        assert_eq!(header_values(res, name.clone()), [value], "{name}");
    }
    assert!(res.headers.get(header::SET_COOKIE).is_none());
}

#[tokio::test]
async fn the_frame_is_served_to_anyone_with_exactly_its_own_headers() {
    let app = TestApp::new();
    let res = app.get("/visual-frame", None).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_frame_headers(&res);
    // One policy, and it is not the app's.
    let csp = header_values(&res, header::CONTENT_SECURITY_POLICY);
    assert_eq!(csp.len(), 1);
    assert!(!csp[0].contains("default-src 'self'"));
    assert!(!csp[0].contains("frame-ancestors 'none'"));
    assert!(!csp[0].contains("connect-src"));
    // It is the host page, not the UI.
    assert!(res.text.starts_with("<!doctype html>"));
    assert!(res.text.contains(r#"qoop: "visual""#));
    assert!(!res.text.contains("Qoop UI"));

    // The same for someone signed in, and with a query string.
    let admin = app.admin().await;
    for (path, cookie) in [
        ("/visual-frame", Some(admin.as_str())),
        ("/visual-frame?v=2", None),
    ] {
        let again = app.get(path, cookie).await;
        assert_eq!(again.status, StatusCode::OK, "{path}");
        assert_frame_headers(&again);
        assert_eq!(again.text, res.text, "{path}");
    }
}

#[tokio::test]
async fn the_frame_wins_over_a_file_of_that_name_in_the_web_dir() {
    let app = TestApp::new();
    std::fs::write(app.web.path().join("visual-frame"), "NOT THE FRAME").unwrap();
    let res = app.get("/visual-frame", None).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_frame_headers(&res);
    assert!(!res.text.contains("NOT THE FRAME"));
}

#[tokio::test]
async fn the_page_carries_the_protocol_and_touches_nothing_else() {
    let app = TestApp::new();
    let text = app.get("/visual-frame", None).await.text;
    let lower = text.to_lowercase();
    for word in [
        "/api",
        "cookie",
        "storage",
        "indexeddb",
        "fetch",
        "xmlhttprequest",
        "websocket",
        "http:",
        "https:",
        "src=",
        "href=",
    ] {
        assert!(!lower.contains(word), "the page mentions {word}");
    }
    // One inline script in the page itself; the second pair is the reporter it writes into
    // the new document, whose closing tag is escaped so it cannot end the host script.
    assert_eq!(text.matches("<script>").count(), 2);
    assert_eq!(text.matches("</script>").count(), 1);
    assert_eq!(text.matches("<\\/script>").count(), 1);
    for part in [
        r#"type: "ready""#,
        r#"data.type !== "render""#,
        "event.source !== host",
        r#"data.qoop !== "visual""#,
        "/^--q-[a-z0-9-]+$/",
        "/[;{}<]/",
        r#"type:"height""#,
        "Math.ceil(d.getBoundingClientRect().height)",
        "ResizeObserver",
        r#"type:"error""#,
        "slice(0,300)",
        "unhandledrejection",
        "document.open();",
        "document.write(doc);",
        "document.close();",
    ] {
        assert!(text.contains(part), "the page lacks {part}");
    }
}

#[tokio::test]
async fn head_gives_the_headers_and_other_methods_are_refused() {
    let app = TestApp::new();
    let head = app
        .send(
            Request::builder()
                .method(Method::HEAD)
                .uri("/visual-frame")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(head.status, StatusCode::OK);
    assert_frame_headers(&head);
    assert_eq!(head.text, "");

    // A write the way the UI sends one: there is nothing to write to.
    for method in [Method::POST, Method::PUT, Method::DELETE] {
        let res = app
            .write(method.clone(), "/visual-frame", None, serde_json::json!({}))
            .await;
        assert_eq!(res.status, StatusCode::METHOD_NOT_ALLOWED, "{method}");
        assert_eq!(res.text, "", "{method}");
        assert_eq!(
            header_values(&res, header::X_CONTENT_TYPE_OPTIONS),
            ["nosniff"]
        );
        assert!(res.headers.get(header::CONTENT_SECURITY_POLICY).is_none());
    }
    // One from anywhere else is stopped by the Origin rule, like every other write.
    let res = app
        .send(
            Request::builder()
                .method(Method::POST)
                .uri("/visual-frame")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.code(), "forbidden_origin");
}

#[tokio::test]
async fn every_other_page_keeps_the_app_policy() {
    let app = TestApp::new();
    // Paths next to the frame are ordinary UI paths.
    for path in [
        "/",
        "/some/ui/path",
        "/visual-frame/",
        "/visual-frames",
        "/visual-frame/x",
    ] {
        let res = app.get(path, None).await;
        assert_eq!(res.status, StatusCode::OK, "{path}");
        assert!(res.text.contains("Qoop UI"), "{path}");
        let csp = header_values(&res, header::CONTENT_SECURITY_POLICY);
        assert_eq!(csp.len(), 1, "{path}");
        assert!(csp[0].starts_with("default-src 'self';"), "{path}");
        assert!(csp[0].ends_with("frame-ancestors 'none'"), "{path}");
        assert!(!csp[0].contains("sandbox"), "{path}");
        assert_eq!(
            header_values(&res, header::REFERRER_POLICY),
            ["same-origin"],
            "{path}"
        );
        assert_eq!(
            header_values(&res, header::X_CONTENT_TYPE_OPTIONS),
            ["nosniff"],
            "{path}"
        );
    }
    // The API is as it was: no policy on JSON, the other two headers on everything.
    let res = app.get("/api/health", None).await;
    assert!(res.headers.get(header::CONTENT_SECURITY_POLICY).is_none());
    assert_eq!(
        header_values(&res, header::REFERRER_POLICY),
        ["same-origin"]
    );
    assert_eq!(
        header_values(&res, header::X_CONTENT_TYPE_OPTIONS),
        ["nosniff"]
    );
}
