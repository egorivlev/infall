mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::*;

#[tokio::test]
async fn unknown_api_routes_are_json_404_never_the_ui() {
    let app = TestApp::new();
    for path in ["/api/nope", "/api/", "/api", "/api/branches/x/nope"] {
        let res = app.get(path, None).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "{path}");
        assert_eq!(res.code(), "not_found", "{path}");
        assert!(!res.text.contains("Infall UI"), "{path}");
    }
    // A wrong method on a known API route is also JSON.
    let res = app.get("/api/auth/login", None).await;
    assert_eq!(res.code(), "not_found");
}

#[tokio::test]
async fn ui_paths_serve_index_html_and_files_serve_themselves() {
    let app = TestApp::new();
    for path in ["/", "/some/ui/path", "/invite/abc"] {
        let res = app.get(path, None).await;
        assert_eq!(res.status, StatusCode::OK, "{path}");
        assert!(res.text.contains("Infall UI"), "{path}");
        assert!(
            res.headers["content-type"]
                .to_str()
                .unwrap()
                .starts_with("text/html")
        );
    }
    let js = app.get("/assets/app.js", None).await;
    assert_eq!(js.status, StatusCode::OK);
    assert!(js.text.contains("console.log"));
    // The UI's entry page is asked for again every time, so an updated server shows its new UI;
    // the files it names carry their content in their name and may be kept.
    let index = app.get("/", None).await;
    assert_eq!(index.headers["cache-control"], "no-cache");
    assert_eq!(
        js.headers["cache-control"],
        "public, max-age=31536000, immutable"
    );
    // A missing asset falls back to the entry page: never kept.
    let missing = app.get("/assets/gone.js", None).await;
    assert_eq!(missing.headers["cache-control"], "no-cache");
}

#[tokio::test]
async fn path_traversal_does_not_escape_the_web_dir() {
    let app = TestApp::new();
    // A secret right next to the web dir.
    let secret = app.web.path().parent().unwrap().join("infall-secret.txt");
    std::fs::write(&secret, "TOP SECRET RESEARCH").unwrap();
    let name = secret.file_name().unwrap().to_str().unwrap();
    for path in [
        format!("/../{name}"),
        format!("/assets/../../{name}"),
        format!("/%2e%2e/{name}"),
        format!("/..%2f{name}"),
        format!("/assets/%2e%2e/%2e%2e/{name}"),
        format!("/..%5c{name}"),
    ] {
        let req = Request::builder().uri(path.as_str()).body(Body::empty());
        let Ok(req) = req else { continue };
        let res = app.send(req).await;
        assert!(!res.text.contains("TOP SECRET"), "{path} leaked");
    }
    std::fs::remove_file(secret).unwrap();
}
