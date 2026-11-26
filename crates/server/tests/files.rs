//! M19 — a PDF on a Source (docs/specs/pdf-sources.md, Part 1; api.md §20): storing a PDF,
//! reading it whole and by range, who may read it, its text, search, the Source's fields,
//! and fetching a PDF from a stand-in for arXiv. No test here reaches the network.

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use common::{ORIGIN, Res, START, TestApp, create, new_id};
use infall_server::files::{FETCHES_PER_MINUTE, MAX_SEARCH_RESULTS, hash_of};
use infall_server::store::{CHUNK_BYTES, MemoryStore, SqliteStore, Store};
use serde_json::{Value, json};

/// A small PDF-looking file: the server checks only that it starts as a PDF.
fn pdf(body: &str) -> Vec<u8> {
    format!("%PDF-1.7\n{body}\n%%EOF\n").into_bytes()
}

/// A file of `n` bytes that starts as a PDF and whose every byte says where it is.
fn big_pdf(n: usize) -> Vec<u8> {
    let mut v = b"%PDF-1.4\n".to_vec();
    while v.len() < n {
        v.push((v.len() % 251) as u8);
    }
    v.truncate(n);
    v
}

fn text(s: &str) -> Value {
    json!({ "Text": s })
}

async fn put_bytes(app: &TestApp, path: &str, cookie: Option<&str>, bytes: Vec<u8>) -> Res {
    let mut b = Request::builder()
        .method(Method::PUT)
        .uri(path)
        .header(header::ORIGIN, ORIGIN)
        .header("x-infall-request", "1")
        .header(header::CONTENT_TYPE, "application/pdf");
    if let Some(c) = cookie {
        b = b.header(header::COOKIE, c);
    }
    app.send(b.body(Body::from(bytes)).unwrap()).await
}

/// The same, sent in pieces without a Content-Length, the way a stream arrives.
async fn put_stream(app: &TestApp, cookie: &str, bytes: Vec<u8>) -> Res {
    let pieces: Vec<Result<Vec<u8>, std::io::Error>> =
        bytes.chunks(1000).map(|c| Ok(c.to_vec())).collect();
    let body = Body::from_stream(futures_util::stream::iter(pieces));
    let req = Request::builder()
        .method(Method::PUT)
        .uri("/api/files/pdf")
        .header(header::ORIGIN, ORIGIN)
        .header("x-infall-request", "1")
        .header(header::COOKIE, cookie)
        .body(body)
        .unwrap();
    app.send(req).await
}

async fn upload(app: &TestApp, cookie: &str, bytes: Vec<u8>) -> String {
    let res = put_bytes(app, "/api/files/pdf", Some(cookie), bytes).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    res.body["hash"].as_str().unwrap().to_string()
}

async fn get_with(app: &TestApp, path: &str, cookie: &str, extra: &[(&str, &str)]) -> Res {
    let mut b = Request::builder()
        .method(Method::GET)
        .uri(path)
        .header(header::COOKIE, cookie);
    for (k, v) in extra {
        b = b.header(*k, *v);
    }
    app.send(b.body(Body::empty()).unwrap()).await
}

/// The raw bytes of a response.
async fn get_bytes(
    app: &TestApp,
    path: &str,
    cookie: &str,
    extra: &[(&str, &str)],
) -> (Res, Vec<u8>) {
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let mut b = Request::builder()
        .method(Method::GET)
        .uri(path)
        .header(header::COOKIE, cookie);
    for (k, v) in extra {
        b = b.header(*k, *v);
    }
    let res = app
        .router
        .clone()
        .oneshot(b.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let bytes = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    (
        Res {
            status,
            headers,
            body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            text: String::from_utf8_lossy(&bytes).to_string(),
        },
        bytes,
    )
}

fn source_with_pdf(id: &str, hash: &str) -> Value {
    create(
        id,
        "Source",
        json!({ "title": text("A paper"), "pdf": text(hash), "pdf_name": text("paper.pdf"),
                "pdf_size": { "Float": 9.0 } }),
    )
}

fn header_of<'a>(res: &'a Res, name: &str) -> &'a str {
    res.headers
        .get(name)
        .map(|v| v.to_str().unwrap())
        .unwrap_or("")
}

#[tokio::test]
async fn a_pdf_is_stored_once_by_its_content() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let bytes = pdf("one");
    let res = put_bytes(&app, "/api/files/pdf", Some(&admin), bytes.clone()).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(
        res.body,
        json!({ "hash": hash_of(&bytes), "size": bytes.len(), "pages": null })
    );
    // The same bytes again: the same answer, nothing new stored.
    let again = put_bytes(&app, "/api/files/pdf", Some(&admin), bytes.clone()).await;
    assert_eq!(again.status, StatusCode::OK);
    assert_eq!(again.body, res.body);
    // And streamed without a length.
    let streamed = put_stream(&app, &admin, bytes.clone()).await;
    assert_eq!(streamed.body, res.body);
    let stored = app.store.pdf_file(&hash_of(&bytes)).unwrap().unwrap();
    assert_eq!(stored.size, bytes.len() as u64);
    assert!(!stored.has_text);

    // A Member may store; a Guest may not, nor anyone signed out or from elsewhere.
    let member = app.join(&admin, "m@example.org", "member", None).await;
    assert_eq!(
        upload(&app, &member, pdf("two")).await,
        hash_of(&pdf("two"))
    );
    let guest = app
        .join(&admin, "g@example.org", "guest", Some(START + 86_400_000))
        .await;
    let res = put_bytes(&app, "/api/files/pdf", Some(&guest), pdf("three")).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    let res = put_bytes(&app, "/api/files/pdf", None, pdf("three")).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    let req = Request::builder()
        .method(Method::PUT)
        .uri("/api/files/pdf")
        .header(header::COOKIE, &admin)
        .body(Body::from(pdf("three")))
        .unwrap();
    assert_eq!(app.send(req).await.code(), "forbidden_origin");
    assert!(
        app.store
            .pdf_file(&hash_of(&pdf("three")))
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn only_a_pdf_is_taken_and_only_up_to_the_limit() {
    let app = TestApp::with_config(Arc::new(MemoryStore::new()), |c| {
        c.max_pdf_bytes = 4096;
    });
    let admin = app.admin().await;
    for not_pdf in [
        b"<html><script>alert(1)</script></html>".to_vec(),
        b"%PDF".to_vec(),
        Vec::new(),
        b"\x89PNG\r\n".to_vec(),
        b" %PDF-1.4".to_vec(),
    ] {
        let res = put_bytes(&app, "/api/files/pdf", Some(&admin), not_pdf.clone()).await;
        assert_eq!(
            res.status,
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "{not_pdf:?}"
        );
        assert_eq!(res.code(), "not_a_pdf");
    }
    // The name and the declared type do not matter: the first bytes do.
    let req = Request::builder()
        .method(Method::PUT)
        .uri("/api/files/pdf")
        .header(header::ORIGIN, ORIGIN)
        .header("x-infall-request", "1")
        .header(header::COOKIE, &admin)
        .header(header::CONTENT_TYPE, "text/html")
        .body(Body::from(pdf("typed as html")))
        .unwrap();
    assert_eq!(app.send(req).await.status, StatusCode::OK);

    let at_limit = big_pdf(4096);
    assert_eq!(upload(&app, &admin, at_limit).await.len(), 64);
    let over = big_pdf(4097);
    let res = put_bytes(&app, "/api/files/pdf", Some(&admin), over.clone()).await;
    assert_eq!(res.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(res.code(), "too_large");
    // Without a Content-Length it is refused as it passes the limit.
    let res = put_stream(&app, &admin, over.clone()).await;
    assert_eq!(res.status, StatusCode::PAYLOAD_TOO_LARGE, "{}", res.text);
    assert!(app.store.pdf_file(&hash_of(&over)).unwrap().is_none());
}

#[tokio::test]
async fn a_pdf_is_read_whole_or_by_range_with_strict_headers() {
    // Large enough to span several stored parts, on the SQLite store.
    let app = TestApp::with_store(Arc::new(SqliteStore::open_in_memory().unwrap()));
    let admin = app.admin().await;
    let bytes = big_pdf(2 * CHUNK_BYTES as usize + 12_345);
    let hash = upload(&app, &admin, bytes.clone()).await;
    let path = format!("/api/files/pdf/{hash}");

    let (res, got) = get_bytes(&app, &path, &admin, &[]).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(got, bytes);
    assert_eq!(header_of(&res, "content-type"), "application/pdf");
    assert_eq!(header_of(&res, "content-disposition"), "inline");
    assert_eq!(header_of(&res, "x-content-type-options"), "nosniff");
    assert_eq!(header_of(&res, "accept-ranges"), "bytes");
    assert_eq!(
        header_of(&res, "cache-control"),
        "private, max-age=31536000, immutable"
    );
    assert_eq!(header_of(&res, "etag"), format!("\"{hash}\""));
    assert_eq!(header_of(&res, "content-length"), bytes.len().to_string());
    assert!(res.headers.get("content-security-policy").is_none());

    let size = bytes.len() as u64;
    let c = CHUNK_BYTES;
    for (range, first, last) in [
        ("bytes=0-99".to_string(), 0, 99),
        // Across the boundary of two stored parts.
        (format!("bytes={}-{}", c - 10, c + 10), c - 10, c + 10),
        // Across three.
        (format!("bytes={}-{}", c - 1, 2 * c + 1), c - 1, 2 * c + 1),
        (format!("bytes={}-", size - 5), size - 5, size - 1),
        ("bytes=-7".to_string(), size - 7, size - 1),
        (format!("bytes=100-{}", size + 1000), 100, size - 1),
        (format!("bytes={c}-{c}"), c, c),
    ] {
        let (res, got) = get_bytes(&app, &path, &admin, &[("range", &range)]).await;
        assert_eq!(res.status, StatusCode::PARTIAL_CONTENT, "{range}");
        assert_eq!(got, bytes[first as usize..=last as usize], "{range}");
        assert_eq!(
            header_of(&res, "content-range"),
            format!("bytes {first}-{last}/{size}")
        );
        assert_eq!(header_of(&res, "content-type"), "application/pdf");
    }
    // Several ranges, or one this server does not read: the whole file.
    for range in ["bytes=0-1,4-5", "pages=1-2", "bytes=9-3"] {
        let (res, got) = get_bytes(&app, &path, &admin, &[("range", range)]).await;
        assert_eq!(res.status, StatusCode::OK, "{range}");
        assert_eq!(got.len(), bytes.len());
    }
    // Outside the file.
    let res = get_with(&app, &path, &admin, &[("range", &format!("bytes={size}-"))]).await;
    assert_eq!(res.status, StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(res.code(), "range_not_satisfiable");
    assert_eq!(header_of(&res, "content-range"), format!("bytes */{size}"));
    // `If-Range` with another validator: the whole file.
    let (res, _) = get_bytes(
        &app,
        &path,
        &admin,
        &[("range", "bytes=0-9"), ("if-range", "\"other\"")],
    )
    .await;
    assert_eq!(res.status, StatusCode::OK);
    let (res, got) = get_bytes(
        &app,
        &path,
        &admin,
        &[("range", "bytes=0-9"), ("if-range", &format!("\"{hash}\""))],
    )
    .await;
    assert_eq!(res.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(got, bytes[..10]);
    // Asked again with the tag it has: nothing to send.
    let (res, got) = get_bytes(
        &app,
        &path,
        &admin,
        &[("if-none-match", &format!("\"{hash}\""))],
    )
    .await;
    assert_eq!(res.status, StatusCode::NOT_MODIFIED);
    assert!(got.is_empty());

    // A hash nothing was stored under, and a path that is no hash.
    let unknown = hash_of(b"never stored");
    let res = app
        .get(&format!("/api/files/pdf/{unknown}"), Some(&admin))
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.code(), "file_missing");
    for bad in ["abc", &hash.to_uppercase(), "../../etc/passwd"] {
        let res = app
            .get(&format!("/api/files/pdf/{bad}"), Some(&admin))
            .await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "{bad}");
        assert_eq!(res.code(), "not_found", "{bad}");
    }
    let res = app.get(&path, None).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_guest_reads_only_a_pdf_a_source_on_main_names_now() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let guest = app
        .join(&admin, "g@example.org", "guest", Some(START + 86_400_000))
        .await;
    let main = app.main_branch(&admin).await;
    let (on_main, on_branch, in_history, deleted, nowhere) = (
        pdf("on main"),
        pdf("on a branch"),
        pdf("in history only"),
        pdf("on a removed source"),
        pdf("stored, named by nothing"),
    );
    let mut hashes = Vec::new();
    for b in [&on_main, &on_branch, &in_history, &deleted, &nowhere] {
        hashes.push(upload(&app, &admin, b.clone()).await);
    }
    let [h_main, h_branch, h_history, h_deleted, h_nowhere] = hashes.try_into().unwrap();
    for h in [&h_main, &h_branch, &h_history, &h_deleted] {
        let res = app
            .put(
                &format!("/api/files/pdf/{h}/text"),
                Some(&admin),
                json!({ "pages": ["the word quasar is here"] }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    }
    let (s_main, s_history, s_deleted) = (new_id(), new_id(), new_id());
    app.ops(
        &admin,
        &main,
        json!([
            source_with_pdf(&s_main, &h_main),
            source_with_pdf(&s_history, &h_history),
            source_with_pdf(&s_deleted, &h_deleted),
        ]),
    )
    .await;
    // The second Source's PDF is replaced; the third Source is removed.
    let seq = app.main_seq(&admin).await;
    app.ops(
        &admin,
        &main,
        json!([
            { "Set": { "entity": s_history, "field": "pdf", "value": text(&h_main) } },
            { "Delete": { "entity": s_deleted } },
        ]),
    )
    .await;
    // A Branch where another Source names another PDF.
    let res = app
        .post(
            "/api/branches",
            Some(&admin),
            json!({ "name": "side", "from": { "branch": main, "seq": seq } }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let side = res.body["branch"]["id"].as_str().unwrap().to_string();
    app.ops(
        &admin,
        &side,
        json!([source_with_pdf(&new_id(), &h_branch)]),
    )
    .await;

    let (res, got) = get_bytes(&app, &format!("/api/files/pdf/{h_main}"), &guest, &[]).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(got, on_main);
    let (res, got) = get_bytes(
        &app,
        &format!("/api/files/pdf/{h_main}"),
        &guest,
        &[("range", "bytes=0-4")],
    )
    .await;
    assert_eq!(res.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(got, b"%PDF-");
    let res = app
        .get(&format!("/api/files/pdf/{h_main}/text"), Some(&guest))
        .await;
    assert_eq!(res.status, StatusCode::OK);

    // On another Branch only, in the past only, on a removed Source, on no Source, never
    // stored at all: the same `404 not_found` for each, so a Guest learns nothing.
    let unknown = hash_of(b"never stored");
    let refusals: Vec<Res> = {
        let mut v = Vec::new();
        for h in [&h_branch, &h_history, &h_deleted, &h_nowhere, &unknown] {
            v.push(app.get(&format!("/api/files/pdf/{h}"), Some(&guest)).await);
            v.push(
                app.get(&format!("/api/files/pdf/{h}/text"), Some(&guest))
                    .await,
            );
        }
        v
    };
    for r in &refusals {
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.text);
        assert_eq!(r.body, refusals[0].body);
        assert_eq!(r.code(), "not_found");
    }
    // A Member reads every one of them.
    for h in [&h_branch, &h_history, &h_deleted, &h_nowhere] {
        let res = app.get(&format!("/api/files/pdf/{h}"), Some(&admin)).await;
        assert_eq!(res.status, StatusCode::OK);
    }

    // Search: a Guest finds only what they may read; a Member finds it all.
    let res = app.get("/api/search/pdf?q=QUASAR", Some(&guest)).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let found: Vec<&str> = res
        .body
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["hash"].as_str().unwrap())
        .collect();
    assert_eq!(found, vec![h_main.as_str()]);
    let res = app.get("/api/search/pdf?q=quasar", Some(&admin)).await;
    assert_eq!(res.body.as_array().unwrap().len(), 4);

    // A Guest stores nothing.
    let res = app
        .put(
            &format!("/api/files/pdf/{h_nowhere}/text"),
            Some(&guest),
            json!({ "pages": ["x"] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    let res = app
        .post(
            "/api/sources/fetch-pdf",
            Some(&guest),
            json!({ "arxiv": "2103.05577" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
}

impl TestApp {
    async fn main_seq(&self, cookie: &str) -> u64 {
        let res = self.get("/api/branches", Some(cookie)).await;
        res.body["branches"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["name"] == "main")
            .unwrap()["seq"]
            .as_u64()
            .unwrap()
    }
}

#[tokio::test]
async fn the_source_fields_have_their_shapes_and_are_content_like_any_other() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let main = app.main_branch(&admin).await;
    let hash = upload(&app, &admin, pdf("paper")).await;
    let source = new_id();
    for (field, bad) in [
        ("pdf", text("not a hash")),
        ("pdf", text(&hash.to_uppercase())),
        ("pdf_name", text("two\nlines.pdf")),
        ("pdf_name", text(&"n".repeat(256))),
        ("pdf_name", text("")),
        ("pdf_size", json!({ "Float": -1.0 })),
        ("pdf_pages", json!({ "Float": 2.5 })),
    ] {
        let res = app
            .post(
                &format!("/api/branches/{main}/ops"),
                Some(&admin),
                json!({ "ops": [create(&source, "Source", json!({ field: bad }))] }),
            )
            .await;
        assert_eq!(
            res.status,
            StatusCode::BAD_REQUEST,
            "{field} {bad}: {}",
            res.text
        );
        assert_eq!(res.code(), "bad_request");
    }
    // The wrong type is the core's to refuse.
    let res = app
        .post(
            &format!("/api/branches/{main}/ops"),
            Some(&admin),
            json!({ "ops": [create(&source, "Source", json!({ "pdf_pages": text("3") }))] }),
        )
        .await;
    assert_eq!(res.code(), "rejected");

    app.ops(
        &admin,
        &main,
        json!([create(&source, "Source", json!({ "title": text("P") }))]),
    )
    .await;
    let before = app.main_seq(&admin).await;
    // Attaching: four Sets, as the web UI sends them.
    app.ops(
        &admin,
        &main,
        json!([
            { "Set": { "entity": source, "field": "pdf", "value": text(&hash) } },
            { "Set": { "entity": source, "field": "pdf_name", "value": text("paper (v2).pdf") } },
            { "Set": { "entity": source, "field": "pdf_size", "value": { "Float": 20.0 } } },
            { "Set": { "entity": source, "field": "pdf_pages", "value": { "Float": 12.0 } } },
        ]),
    )
    .await;
    let board = app
        .get(&format!("/api/branches/{main}/board"), Some(&admin))
        .await;
    let fields = &board.body["entities"][&source]["fields"];
    assert_eq!(fields["pdf"], text(&hash));
    assert_eq!(fields["pdf_pages"], json!({ "Float": 12.0 }));
    // Taken back by a Restore like any field (Undo works the same way, by ops).
    let res = app
        .post(
            &format!("/api/branches/{main}/restore"),
            Some(&admin),
            json!({ "to_seq": before }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let board = app
        .get(&format!("/api/branches/{main}/board"), Some(&admin))
        .await;
    assert!(
        board.body["entities"][&source]["fields"]
            .get("pdf")
            .is_none()
    );
    // The bytes stay (decision 3).
    let res = app
        .get(&format!("/api/files/pdf/{hash}"), Some(&admin))
        .await;
    assert_eq!(res.status, StatusCode::OK);
}

#[tokio::test]
async fn the_text_of_a_pdf_is_stored_once() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let hash = upload(&app, &admin, pdf("text")).await;
    let path = format!("/api/files/pdf/{hash}/text");

    let res = app.get(&path, Some(&admin)).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.code(), "no_text");
    // For a file that is not stored.
    let unknown = hash_of(b"unknown");
    let res = app
        .put(
            &format!("/api/files/pdf/{unknown}/text"),
            Some(&admin),
            json!({ "pages": ["a"] }),
        )
        .await;
    assert_eq!(res.code(), "file_missing");
    let res = app
        .get(&format!("/api/files/pdf/{unknown}/text"), Some(&admin))
        .await;
    assert_eq!(res.code(), "file_missing");

    for bad in [
        json!({}),
        json!({ "pages": "one" }),
        json!({ "pages": [1, 2] }),
        json!({ "pages": [], "more": 1 }),
        json!(["a"]),
    ] {
        let res = app.put(&path, Some(&admin), bad.clone()).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{bad}");
    }
    let first = json!({ "pages": ["Page one.", "", "Page three, with ünïcode."] });
    let res = app.put(&path, Some(&admin), first.clone()).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body, json!({ "stored": true }));
    let res = app
        .put(&path, Some(&admin), json!({ "pages": ["Something else"] }))
        .await;
    assert_eq!(res.body, json!({ "stored": false }));
    let res = app.get(&path, Some(&admin)).await;
    assert_eq!(res.body, first);

    // At most 20 MB of body.
    let other = upload(&app, &admin, pdf("big text")).await;
    let page = "w".repeat(1024 * 1024);
    let body = json!({ "pages": vec![page; 21] }).to_string();
    let res = app
        .write_raw(
            Method::PUT,
            &format!("/api/files/pdf/{other}/text"),
            &admin,
            body,
        )
        .await;
    assert_eq!(res.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(res.code(), "too_large");
    let page = "w".repeat(1024 * 1024);
    let body = json!({ "pages": vec![page; 19] }).to_string();
    let res = app
        .write_raw(
            Method::PUT,
            &format!("/api/files/pdf/{other}/text"),
            &admin,
            body,
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
}

#[tokio::test]
async fn search_finds_words_in_the_text_of_pdfs() {
    for store in [
        Arc::new(MemoryStore::new()) as Arc<dyn Store>,
        Arc::new(SqliteStore::open_in_memory().unwrap()),
    ] {
        let app = TestApp::with_store(store);
        let admin = app.admin().await;
        let a = upload(&app, &admin, pdf("a")).await;
        let b = upload(&app, &admin, pdf("b")).await;
        app.put(
            &format!("/api/files/pdf/{a}/text"),
            Some(&admin),
            json!({ "pages": ["Intro.", "Nothing.", "The Surface\nCode is a stabilizer code."] }),
        )
        .await;
        app.put(
            &format!("/api/files/pdf/{b}/text"),
            Some(&admin),
            json!({ "pages": ["surface code again", "SURFACE CODE"] }),
        )
        .await;
        let res = app
            .get("/api/search/pdf?q=surface%20code", Some(&admin))
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        let hits = res.body.as_array().unwrap();
        let mut expected = vec![(a.clone(), 3), (b.clone(), 1), (b.clone(), 2)];
        expected.sort();
        let got: Vec<(String, u64)> = hits
            .iter()
            .map(|h| {
                (
                    h["hash"].as_str().unwrap().to_string(),
                    h["page"].as_u64().unwrap(),
                )
            })
            .collect();
        assert_eq!(got, expected);
        let on_a = hits.iter().find(|h| h["hash"] == a.as_str()).unwrap();
        assert_eq!(on_a["snippet"], "The Surface Code is a stabilizer code.");
        let res = app.get("/api/search/pdf?q=absent", Some(&admin)).await;
        assert_eq!(res.body, json!([]));
        for bad in ["", "?q=", "?q=%20%20", &format!("?q={}", "x".repeat(201))] {
            let res = app
                .get(&format!("/api/search/pdf{bad}"), Some(&admin))
                .await;
            assert_eq!(res.status, StatusCode::BAD_REQUEST, "{bad}");
        }
        let res = app.get("/api/search/pdf?q=code", None).await;
        assert_eq!(res.status, StatusCode::UNAUTHORIZED);

        // At most 50 results.
        let many = upload(&app, &admin, pdf("many")).await;
        app.put(
            &format!("/api/files/pdf/{many}/text"),
            Some(&admin),
            json!({ "pages": vec!["needle"; 80] }),
        )
        .await;
        let res = app.get("/api/search/pdf?q=needle", Some(&admin)).await;
        assert_eq!(res.body.as_array().unwrap().len(), MAX_SEARCH_RESULTS);
    }
}

// ---------------------------------------------------------------- arXiv

#[derive(Clone)]
enum Answer {
    Status(u16, Vec<u8>),
    Hang,
    /// Headers, the first bytes, and then nothing more.
    Stall,
}

#[derive(Default)]
struct Fake {
    answer: Mutex<Option<Answer>>,
    seen: Mutex<Vec<(String, HeaderMap)>>,
}

async fn serve(State(fake): State<Arc<Fake>>, req: Request) -> Response {
    fake.seen
        .lock()
        .unwrap()
        .push((req.uri().to_string(), req.headers().clone()));
    let answer = fake.answer.lock().unwrap().clone();
    match answer {
        None => (StatusCode::INTERNAL_SERVER_ERROR, "no answer").into_response(),
        Some(Answer::Hang) => {
            tokio::time::sleep(Duration::from_secs(3600)).await;
            StatusCode::OK.into_response()
        }
        Some(Answer::Stall) => {
            let first = futures_util::stream::once(async {
                Ok::<_, std::io::Error>(axum::body::Bytes::from_static(b"%PDF-1.5\n"))
            });
            let never = futures_util::stream::pending();
            Response::builder()
                .status(200)
                .header("content-type", "application/pdf")
                .body(Body::from_stream(first.chain(never)))
                .unwrap()
        }
        Some(Answer::Status(status, body)) => Response::builder()
            .status(status)
            .header("content-type", "application/pdf")
            .body(Body::from(body))
            .unwrap(),
    }
}

use futures_util::StreamExt;

async fn fake_arxiv() -> (String, Arc<Fake>) {
    let fake = Arc::new(Fake::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = Router::new().fallback(serve).with_state(fake.clone());
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{addr}"), fake)
}

#[tokio::test]
async fn a_pdf_is_fetched_from_arxiv_only_when_asked_and_only_by_its_id() {
    let (url, fake) = fake_arxiv().await;
    let app = TestApp::with_config(Arc::new(MemoryStore::new()), |c| {
        c.arxiv_url = url.clone();
        c.crossref_url = "http://127.0.0.1:9".to_string();
        c.pdf_fetch_timeout = Duration::from_millis(400);
        c.max_pdf_bytes = 64 * 1024;
    });
    let admin = app.admin().await;
    let answer = |a: Answer| *fake.answer.lock().unwrap() = Some(a);
    let fetch = |id: &str| {
        let body = json!({ "arxiv": id });
        let app = &app;
        let admin = admin.clone();
        async move { app.post("/api/sources/fetch-pdf", Some(&admin), body).await }
    };

    // Found.
    let paper = pdf("arXiv paper");
    answer(Answer::Status(200, paper.clone()));
    let res = fetch("arXiv:2103.05577v2").await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(
        res.body,
        json!({ "hash": hash_of(&paper), "size": paper.len(), "pages": null })
    );
    let (got, _) = get_bytes(
        &app,
        &format!("/api/files/pdf/{}", hash_of(&paper)),
        &admin,
        &[],
    )
    .await;
    assert_eq!(got.status, StatusCode::OK);
    {
        let seen = fake.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        let (uri, headers) = &seen[0];
        assert_eq!(uri, "/pdf/2103.05577v2");
        // Only the id travels: no cookie, no name, a generic client name.
        assert!(headers.get("cookie").is_none());
        assert!(headers.get("authorization").is_none());
        assert!(
            headers["user-agent"]
                .to_str()
                .unwrap()
                .starts_with("infall-server/")
        );
        let all = format!("{headers:?}");
        assert!(!all.contains("admin@example.org") && !all.contains("Ada"));
    }
    // An old-style id goes into the path as it is.
    answer(Answer::Status(200, paper.clone()));
    assert_eq!(fetch("hep-th/9711200").await.status, StatusCode::OK);
    assert_eq!(fake.seen.lock().unwrap()[1].0, "/pdf/hep-th/9711200");

    // arXiv does not know it.
    answer(Answer::Status(404, b"not found".to_vec()));
    let res = fetch("2101.99999").await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.code(), "not_found");
    assert!(
        res.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("arXiv")
    );

    // Too slow to answer, or stops sending.
    for slow in [Answer::Hang, Answer::Stall] {
        answer(slow);
        let res = fetch("2103.05577").await;
        assert_eq!(res.status, StatusCode::BAD_GATEWAY, "{}", res.text);
        assert_eq!(res.code(), "fetch_failed");
        assert!(
            res.body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("30 seconds")
        );
    }
    // Something that is not a PDF (arXiv's own page saying there is none, say).
    answer(Answer::Status(200, b"<html>No PDF</html>".to_vec()));
    let res = fetch("2103.05577").await;
    assert_eq!(res.status, StatusCode::BAD_GATEWAY);
    assert_eq!(res.code(), "fetch_failed");
    // Another error.
    answer(Answer::Status(503, Vec::new()));
    let res = fetch("2103.05577").await;
    assert_eq!(res.code(), "fetch_failed");
    let sentence = res.body["error"]["message"].as_str().unwrap();
    assert!(sentence.ends_with("attach it."), "{sentence}");
    // Larger than this server takes.
    let big = big_pdf(64 * 1024 + 1);
    answer(Answer::Status(200, big.clone()));
    let res = fetch("2103.05577").await;
    assert_eq!(res.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(res.code(), "too_large");
    assert!(app.store.pdf_file(&hash_of(&big)).unwrap().is_none());

    // Not an arXiv id, or not the body: nothing is sent, nothing counted.
    let before = fake.seen.lock().unwrap().len();
    for bad in [
        json!({ "arxiv": "nope" }),
        json!({ "doi": "10.1038/nature12373" }),
        json!({ "arxiv": "2103.05577", "doi": "10.1/x" }),
        json!({ "arxiv": 5 }),
        json!("2103.05577"),
    ] {
        let res = app
            .post("/api/sources/fetch-pdf", Some(&admin), bad.clone())
            .await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{bad}");
    }
    assert_eq!(fake.seen.lock().unwrap().len(), before);
}

#[tokio::test]
async fn fetching_from_arxiv_is_limited_per_member() {
    let (url, fake) = fake_arxiv().await;
    let app = TestApp::with_config(Arc::new(MemoryStore::new()), |c| {
        c.arxiv_url = url.clone();
    });
    let admin = app.admin().await;
    *fake.answer.lock().unwrap() = Some(Answer::Status(404, Vec::new()));
    for _ in 0..FETCHES_PER_MINUTE {
        let res = app
            .post(
                "/api/sources/fetch-pdf",
                Some(&admin),
                json!({ "arxiv": "2103.05577" }),
            )
            .await;
        assert_eq!(res.status, StatusCode::NOT_FOUND);
    }
    let res = app
        .post(
            "/api/sources/fetch-pdf",
            Some(&admin),
            json!({ "arxiv": "2103.05577" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS);
    // Another Member has their own count, and the minute passes.
    let member = app.join(&admin, "m@example.org", "member", None).await;
    let res = app
        .post(
            "/api/sources/fetch-pdf",
            Some(&member),
            json!({ "arxiv": "2103.05577" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    app.clock.advance(61_000);
    let res = app
        .post(
            "/api/sources/fetch-pdf",
            Some(&admin),
            json!({ "arxiv": "2103.05577" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn the_reader_may_run_its_worker_from_this_origin_only() {
    let app = TestApp::new();
    let res = app.get("/", None).await;
    let csp = header_of(&res, "content-security-policy");
    assert!(csp.contains("worker-src 'self';"), "{csp}");
    assert!(csp.starts_with("default-src 'self';"), "{csp}");
    assert!(
        !csp.contains("blob:") && !csp.contains("unsafe-eval"),
        "{csp}"
    );
}

#[tokio::test]
async fn head_gives_the_headers_of_a_pdf_alone() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let bytes = pdf("head");
    let hash = upload(&app, &admin, bytes.clone()).await;
    let req = Request::builder()
        .method(Method::HEAD)
        .uri(format!("/api/files/pdf/{hash}"))
        .header(header::COOKIE, &admin)
        .body(Body::empty())
        .unwrap();
    let res = app.send(req).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(header_of(&res, "content-type"), "application/pdf");
    assert_eq!(header_of(&res, "content-length"), bytes.len().to_string());
    assert!(res.text.is_empty());
}
