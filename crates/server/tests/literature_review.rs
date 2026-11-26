//! M19's "thirty PDFs in a literature review export whole" (docs/specs/pdf-sources.md, Done
//! when): a Local Workspace with thirty Sources, each carrying its own PDF of a few hundred KB
//! to a few MB, exported with and without its files and imported into fresh databases. With
//! them every PDF reads back byte for byte; without them every Source still names its file
//! and is answered `404 file_missing`. The PDFs are made here, valid and distinct; nothing
//! binary is committed.
//!
//! About 51 MB of PDFs pass through uploads, two exports and two imports (some 5 s in a
//! debug build, 3 s in a release one, on a laptop), so it is not part of the quick run:
//!
//!     cargo test -p infall-server --test literature_review -- --ignored --nocapture
//!
//! or with every other ignored test: `cargo test -- --include-ignored`. It prints its times.

mod common;

use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use common::{ORIGIN, START, TestApp, create, new_id, web_dir};
use http_body_util::BodyExt;
use infall_server::Clock;
use infall_server::files::hash_of;
use infall_server::local::{
    ExportOptions, FileStats, Preset, build_local_app_with, export_workspace,
    export_workspace_with, file_stats, import_workspace, local_config,
};
use infall_server::store::{SqliteStore, Store};
use serde_json::{Value, json};
use tower::ServiceExt;

const PAPERS: usize = 30;

/// A small deterministic generator, so each paper's bytes are its own and the same each run.
struct Noise(u64);

impl Noise {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

/// A valid PDF of about `size` bytes: one page that reads "Paper <n>", and a binary stream
/// (an embedded file's worth of incompressible bytes) that makes up the size. The
/// cross-reference table gives every object's true offset.
fn paper(n: usize, size: usize) -> Vec<u8> {
    let mut out: Vec<u8> = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n".to_vec();
    let mut offsets = Vec::new();
    let mut object = |out: &mut Vec<u8>, body: &[u8]| {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", offsets.len()).as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    };
    object(&mut out, b"<< /Type /Catalog /Pages 2 0 R >>");
    object(&mut out, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    object(
        &mut out,
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    );
    let text = format!("BT /F1 24 Tf 72 700 Td (Paper {n} of the literature review) Tj ET");
    object(
        &mut out,
        format!("<< /Length {} >>\nstream\n{text}\nendstream", text.len()).as_bytes(),
    );
    object(
        &mut out,
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    );
    let fill = size.saturating_sub(out.len() + 400);
    let mut noise = Noise(0x9e37_79b9_7f4a_7c15 ^ (n as u64 + 1));
    let mut data = Vec::with_capacity(fill + 8);
    while data.len() < fill {
        data.extend_from_slice(&noise.next().to_le_bytes());
    }
    data.truncate(fill);
    let mut stream = format!("<< /Type /EmbeddedFile /Length {fill} >>\nstream\n").into_bytes();
    stream.extend_from_slice(&data);
    stream.extend_from_slice(b"\nendstream");
    object(&mut out, &stream);
    let xref = out.len();
    out.extend_from_slice(
        format!("xref\n0 {}\n0000000000 65535 f \n", offsets.len() + 1).as_bytes(),
    );
    for at in &offsets {
        out.extend_from_slice(format!("{at:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            offsets.len() + 1
        )
        .as_bytes(),
    );
    out
}

/// From 300 KB to about 3.2 MB, spread over the thirty.
fn size_of_paper(n: usize) -> usize {
    300 * 1024 + n * 100 * 1024
}

async fn send_bytes(
    app: &TestApp,
    method: Method,
    path: &str,
    cookie: &str,
    body: Vec<u8>,
) -> (StatusCode, Vec<u8>) {
    let req = Request::builder()
        .method(method)
        .uri(path)
        .header(header::ORIGIN, ORIGIN)
        .header("x-infall-request", "1")
        .header(header::COOKIE, cookie)
        .body(Body::from(body))
        .unwrap();
    let res = app.router.clone().oneshot(req).await.unwrap();
    let status = res.status();
    (
        status,
        res.into_body().collect().await.unwrap().to_bytes().to_vec(),
    )
}

/// A Local Workspace on a database file, driven without a socket, and signed in.
async fn local(db: &Path) -> (TestApp, String) {
    let store: Arc<dyn Store> = Arc::new(SqliteStore::open(db).unwrap());
    let web = web_dir();
    let mut config = local_config(([127, 0, 0, 1], 4321).into(), web.path().to_path_buf());
    config.dev_origin = Some(ORIGIN.to_string());
    config.db = db.to_path_buf();
    let clock = Clock::manual(START);
    let built = build_local_app_with(
        config,
        store.clone(),
        clock.clone(),
        Preset::Blank,
        "Ana",
        false,
        None,
    )
    .unwrap();
    let app = TestApp {
        router: built.router,
        clock,
        store,
        web,
    };
    let res = app
        .get(&format!("/api/local/enter?key={}", built.entry_key), None)
        .await;
    assert_eq!(res.status, StatusCode::SEE_OTHER, "{}", res.text);
    let cookie = res.cookie();
    (app, cookie)
}

/// Every Source on `main` with the hash its `pdf` field names, by title.
async fn sources(app: &TestApp, cookie: &str) -> Vec<(String, String)> {
    let main = app.main_branch(cookie).await;
    let board = app
        .get(&format!("/api/branches/{main}/board"), Some(cookie))
        .await;
    let mut out: Vec<(String, String)> = board.body["entities"]
        .as_object()
        .unwrap()
        .values()
        .filter(|e| e["kind"] == "Source")
        .map(|e| {
            let text = |f: &str| e["fields"][f]["Text"].as_str().unwrap().to_string();
            (text("title"), text("pdf"))
        })
        .collect();
    out.sort();
    out
}

#[tokio::test]
#[ignore = "about 51 MB of PDFs; run with --ignored (see the top of this file)"]
async fn a_literature_review_of_thirty_pdfs_exports_whole() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("review").join("workspace.db");
    std::fs::create_dir_all(db.parent().unwrap()).unwrap();
    let (app, cookie) = local(&db).await;

    let started = Instant::now();
    let papers: Vec<Vec<u8>> = (0..PAPERS).map(|n| paper(n, size_of_paper(n))).collect();
    let total: usize = papers.iter().map(Vec::len).sum();
    let mut expected: Vec<(String, String)> = Vec::new();
    let mut ops: Vec<Value> = Vec::new();
    for (n, bytes) in papers.iter().enumerate() {
        assert!(bytes.starts_with(b"%PDF-1.7") && bytes.ends_with(b"%%EOF\n"));
        let (status, body) =
            send_bytes(&app, Method::PUT, "/api/files/pdf", &cookie, bytes.clone()).await;
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
        let hash = hash_of(bytes);
        let answer: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(answer["hash"], hash);
        let title = format!("Paper {n:02}");
        ops.push(create(
            &new_id(),
            "Source",
            json!({ "title": { "Text": title }, "url": { "Text": format!("https://example.org/paper/{n}") },
                    "pdf": { "Text": hash }, "pdf_name": { "Text": format!("paper-{n:02}.pdf") },
                    "pdf_size": { "Float": bytes.len() as f64 }, "pdf_pages": { "Float": 1.0 } }),
        ));
        expected.push((title, hash));
    }
    let main = app.main_branch(&cookie).await;
    app.ops(&cookie, &main, json!(ops)).await;
    expected.sort();
    assert_eq!(sources(&app, &cookie).await, expected);
    assert_eq!(
        file_stats(&db).unwrap(),
        FileStats {
            count: PAPERS as u64,
            bytes: total as u64
        }
    );
    let stored = started.elapsed();

    // With the PDFs: each reads back byte for byte from a fresh database.
    let t = Instant::now();
    let with = dir.path().join("with.infall");
    export_workspace(&db, &with).unwrap();
    let export_with = t.elapsed();
    let with_size = std::fs::metadata(&with).unwrap().len();
    assert!(
        with_size > total as u64,
        "{with_size} bytes for {total} of PDFs"
    );
    let t = Instant::now();
    let back = dir.path().join("back").join("workspace.db");
    import_workspace(&with, &back).unwrap();
    let import_with = t.elapsed();
    let (b, b_cookie) = local(&back).await;
    assert_eq!(sources(&b, &b_cookie).await, expected);
    for (n, bytes) in papers.iter().enumerate() {
        let hash = hash_of(bytes);
        let (status, got) = send_bytes(
            &b,
            Method::GET,
            &format!("/api/files/pdf/{hash}"),
            &b_cookie,
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "paper {n}");
        assert!(got == *bytes, "paper {n} came back changed");
    }
    assert_eq!(file_stats(&back).unwrap(), file_stats(&db).unwrap());

    // Without them: the Sources are all there, and each says its file is missing.
    let t = Instant::now();
    let without = dir.path().join("without.infall");
    export_workspace_with(
        &db,
        &without,
        ExportOptions {
            include_files: false,
        },
    )
    .unwrap();
    let export_without = t.elapsed();
    let without_size = std::fs::metadata(&without).unwrap().len();
    assert!(
        without_size < 1024 * 1024,
        "{without_size} bytes without the PDFs"
    );
    let bare = dir.path().join("bare").join("workspace.db");
    import_workspace(&without, &bare).unwrap();
    assert_eq!(file_stats(&bare).unwrap(), FileStats::default());
    let (c, c_cookie) = local(&bare).await;
    assert_eq!(sources(&c, &c_cookie).await, expected);
    for (_, hash) in &expected {
        let res = c
            .get(&format!("/api/files/pdf/{hash}"), Some(&c_cookie))
            .await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "{hash}");
        assert_eq!(res.code(), "file_missing", "{hash}");
    }

    eprintln!(
        "thirty PDFs, {:.1} MB: stored in {stored:.2?}; exported with them in {export_with:.2?} \
         ({:.1} MB), imported in {import_with:.2?}; exported without them in \
         {export_without:.2?} ({} KB); all in {:.2?}",
        total as f64 / 1048576.0,
        with_size as f64 / 1048576.0,
        without_size / 1024,
        started.elapsed()
    );
}
