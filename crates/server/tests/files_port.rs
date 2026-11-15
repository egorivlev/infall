//! M19 — stored PDFs in Workspace files (docs/specs/pdf-sources.md, decision 6; api.md §20):
//! carried by every export and every import — Local, Team to Team, Team to Local, Local to
//! Team, the command line, a database copied by hand — left out on request, and then named
//! by their Sources but answered `404 file_missing`.

mod common;

use std::path::Path;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use common::{ORIGIN, PASSWORD, Res, START, TestApp, create, new_id, web_dir};
use http_body_util::BodyExt;
use qoop_server::Clock;
use qoop_server::files::hash_of;
use qoop_server::local::{
    ExportOptions, FileStats, Preset, build_local_app_with, export_for_move, export_workspace,
    export_workspace_with, file_stats, import_workspace, local_config,
};
use qoop_server::store::{SqliteStore, Store};
use serde_json::json;
use tower::ServiceExt;

/// What the PDF holds: found in a file's raw bytes only if the PDF went with it.
const MARK: &str = "MARK-OF-THE-PDF-7f3a91";
/// What its text holds.
const TEXT_MARK: &str = "TEXTMARK-of-page-two-0c55";

fn the_pdf() -> Vec<u8> {
    format!("%PDF-1.7\n{MARK}\n%%EOF\n").into_bytes()
}

fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack
        .windows(needle.len())
        .any(|w| w == needle.as_bytes())
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
        .header("x-qoop-request", "1")
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

/// Stores the PDF and its text, and puts a Source naming it on `main`. Returns the hash.
async fn attach(app: &TestApp, cookie: &str) -> String {
    let (status, body) = send_bytes(app, Method::PUT, "/api/files/pdf", cookie, the_pdf()).await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    let hash = hash_of(&the_pdf());
    let res = app
        .put(
            &format!("/api/files/pdf/{hash}/text"),
            Some(cookie),
            json!({ "pages": ["page one", format!("page two {TEXT_MARK}")] }),
        )
        .await;
    assert_eq!(res.body, json!({ "stored": true }), "{}", res.text);
    let main = app.main_branch(cookie).await;
    app.ops(
        cookie,
        &main,
        json!([create(
            &new_id(),
            "Source",
            json!({ "title": { "Text": "The paper" }, "pdf": { "Text": hash },
                    "pdf_name": { "Text": "paper.pdf" },
                    "pdf_size": { "Float": the_pdf().len() as f64 } })
        )]),
    )
    .await;
    hash
}

/// The PDF and its text, read back over HTTP; both must be there.
async fn assert_carried(app: &TestApp, cookie: &str, hash: &str) {
    let (status, got) = send_bytes(
        app,
        Method::GET,
        &format!("/api/files/pdf/{hash}"),
        cookie,
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(got, the_pdf());
    let res = app
        .get(&format!("/api/files/pdf/{hash}/text"), Some(cookie))
        .await;
    assert_eq!(
        res.body["pages"][1],
        format!("page two {TEXT_MARK}"),
        "{}",
        res.text
    );
    let res = app.get("/api/search/pdf?q=textmark", Some(cookie)).await;
    assert_eq!(res.body[0]["page"], 2, "{}", res.text);
}

/// The Source still names the PDF, whose bytes are not here.
async fn assert_left_out(app: &TestApp, cookie: &str, hash: &str) {
    let main = app.main_branch(cookie).await;
    let board = app
        .get(&format!("/api/branches/{main}/board"), Some(cookie))
        .await;
    let named = board.body["entities"]
        .as_object()
        .unwrap()
        .values()
        .any(|e| e["fields"]["pdf"]["Text"] == hash);
    assert!(named, "the Source lost its pdf field");
    for path in [
        format!("/api/files/pdf/{hash}"),
        format!("/api/files/pdf/{hash}/text"),
    ] {
        let res: Res = app.get(&path, Some(cookie)).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "{path}");
        assert_eq!(res.code(), "file_missing", "{path}");
    }
    let res = app.get("/api/search/pdf?q=textmark", Some(cookie)).await;
    assert_eq!(res.body, json!([]));
}

// ---------------------------------------------------------------- harness

/// A Team Workspace on a database file, whose `config.db` is that file.
fn team(dir: &Path, name: &str) -> TestApp {
    let db = dir.join(format!("{name}.db"));
    let store: Arc<dyn Store> = Arc::new(SqliteStore::open(&db).unwrap());
    TestApp::with_config(store, |c| c.db = db.clone())
}

async fn admin_of(app: &TestApp, email: &str) -> String {
    qoop_server::create_admin(&*app.store, email, "Ada Admin", PASSWORD, START).unwrap();
    let res = app.login(email, PASSWORD).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    res.cookie()
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

fn pdf_rows(file: &Path) -> i64 {
    let conn = rusqlite::Connection::open(file).unwrap();
    ["pdf_files", "pdf_chunks", "pdf_text"]
        .iter()
        .map(|t| {
            conn.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap()
        })
        .sum()
}

const WITHOUT: ExportOptions = ExportOptions {
    include_files: false,
};

// ---------------------------------------------------------------- Local

#[tokio::test]
async fn a_local_workspace_file_carries_its_pdfs_unless_told_not_to() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("a").join("workspace.db");
    std::fs::create_dir_all(db.parent().unwrap()).unwrap();
    let (app, cookie) = local(&db).await;
    assert_eq!(file_stats(&db).unwrap(), FileStats::default());
    let hash = attach(&app, &cookie).await;
    assert_eq!(
        file_stats(&db).unwrap(),
        FileStats {
            count: 1,
            bytes: the_pdf().len() as u64
        }
    );
    // The same bytes stored twice are one file.
    send_bytes(&app, Method::PUT, "/api/files/pdf", &cookie, the_pdf()).await;
    assert_eq!(file_stats(&db).unwrap().count, 1);

    // With the PDFs (the default, as backups and moves make them).
    let with = dir.path().join("with.infall");
    export_workspace(&db, &with).unwrap();
    let raw = std::fs::read(&with).unwrap();
    assert!(contains(&raw, MARK) && contains(&raw, TEXT_MARK));
    assert_eq!(pdf_rows(&with), 1 + 1 + 2);
    // Stored PDFs are content, not secrets: who stored them, from where, is not recorded.
    let conn = rusqlite::Connection::open(&with).unwrap();
    let cols: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('pdf_files') ORDER BY cid")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(cols, ["hash", "size", "created_at", "text_pages"]);
    drop(conn);
    let back = dir.path().join("b").join("workspace.db");
    import_workspace(&with, &back).unwrap();
    assert_eq!(file_stats(&back).unwrap().count, 1);
    let (b, b_cookie) = local(&back).await;
    assert_carried(&b, &b_cookie, &hash).await;

    // `export_for_move` carries them too.
    let moved = dir.path().join("move.infall");
    export_for_move(&db, &moved).unwrap();
    assert!(contains(&std::fs::read(&moved).unwrap(), MARK));

    // Without: not a byte of the PDF or its text in the file, which imports cleanly.
    let without = dir.path().join("without.infall");
    export_workspace_with(&db, &without, WITHOUT).unwrap();
    let raw = std::fs::read(&without).unwrap();
    assert!(!contains(&raw, MARK) && !contains(&raw, TEXT_MARK));
    assert_eq!(pdf_rows(&without), 0);
    let bare = dir.path().join("c").join("workspace.db");
    import_workspace(&without, &bare).unwrap();
    assert_eq!(file_stats(&bare).unwrap(), FileStats::default());
    let (c, c_cookie) = local(&bare).await;
    assert_left_out(&c, &c_cookie, &hash).await;
    // Attaching the same file again brings it back for the Source as it is.
    send_bytes(&c, Method::PUT, "/api/files/pdf", &c_cookie, the_pdf()).await;
    let res = c
        .get(&format!("/api/files/pdf/{hash}"), Some(&c_cookie))
        .await;
    assert_eq!(res.status, StatusCode::OK);

    // A database copied by hand (the rescue path) keeps them as well.
    let rescued = dir.path().join("d").join("workspace.db");
    import_workspace(&db, &rescued).unwrap();
    let (d, d_cookie) = local(&rescued).await;
    assert_carried(&d, &d_cookie, &hash).await;

    // No database, no numbers.
    assert!(file_stats(&dir.path().join("nothing.db")).is_err());
    assert!(!dir.path().join("nothing.db").exists());
}

// ---------------------------------------------------------------- Team

#[tokio::test]
async fn a_team_workspace_file_carries_its_pdfs_in_every_direction() {
    let dir = tempfile::tempdir().unwrap();
    let a = team(dir.path(), "a");
    let a_admin = admin_of(&a, "ada@example.org").await;
    let hash = attach(&a, &a_admin).await;

    // Over HTTP, Team to Team.
    let (status, file) = send_bytes(
        &a,
        Method::GET,
        "/api/workspace/export",
        &a_admin,
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(contains(&file, MARK) && contains(&file, TEXT_MARK));
    let b = team(dir.path(), "b");
    let b_admin = admin_of(&b, "bea@example.org").await;
    // B already has the same PDF without its text, and another one: both stay, and the
    // file's text fills in what B lacked.
    let other = b"%PDF-1.4 another one".to_vec();
    send_bytes(&b, Method::PUT, "/api/files/pdf", &b_admin, the_pdf()).await;
    send_bytes(&b, Method::PUT, "/api/files/pdf", &b_admin, other.clone()).await;
    let (status, body) = send_bytes(
        &b,
        Method::POST,
        "/api/workspace/import",
        &b_admin,
        file.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    assert_carried(&b, &b_admin, &hash).await;
    let res = b
        .get(
            &format!("/api/files/pdf/{}", hash_of(&other)),
            Some(&b_admin),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);

    // Team to Local.
    let team_file = dir.path().join("team.infall");
    std::fs::write(&team_file, &file).unwrap();
    let home = dir.path().join("home").join("workspace.db");
    let imported = import_workspace(&team_file, &home).unwrap();
    assert!(imported.from_team);
    let (h, h_cookie) = local(&home).await;
    assert_carried(&h, &h_cookie, &hash).await;

    // `export_workspace` of a Team database (what `export-workspace` runs), and without the
    // PDFs: the Team file then comes in with the Source naming a PDF that is not there.
    let a_db = dir.path().join("a.db");
    let full = dir.path().join("full.infall");
    export_workspace(&a_db, &full).unwrap();
    assert!(contains(&std::fs::read(&full).unwrap(), MARK));
    let bare = dir.path().join("bare.infall");
    export_workspace_with(&a_db, &bare, WITHOUT).unwrap();
    let raw = std::fs::read(&bare).unwrap();
    assert!(!contains(&raw, MARK) && !contains(&raw, TEXT_MARK));
    let c = team(dir.path(), "c");
    let c_admin = admin_of(&c, "cy@example.org").await;
    let (status, _) = send_bytes(&c, Method::POST, "/api/workspace/import", &c_admin, raw).await;
    assert_eq!(status, StatusCode::OK);
    assert_left_out(&c, &c_admin, &hash).await;
}

#[tokio::test]
async fn a_local_workspace_moved_onto_a_team_server_brings_its_pdfs() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("l").join("workspace.db");
    std::fs::create_dir_all(db.parent().unwrap()).unwrap();
    let (l, l_cookie) = local(&db).await;
    let hash = attach(&l, &l_cookie).await;
    let file = dir.path().join("move.infall");
    export_for_move(&db, &file).unwrap();
    let t = team(dir.path(), "t");
    let t_admin = admin_of(&t, "ada@example.org").await;
    let (status, body) = send_bytes(
        &t,
        Method::POST,
        "/api/workspace/import",
        &t_admin,
        std::fs::read(&file).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    assert_carried(&t, &t_admin, &hash).await;
}

#[tokio::test]
async fn the_command_line_exports_and_imports_the_pdfs() {
    const BIN: &str = env!("CARGO_BIN_EXE_qoop-server");
    let dir = tempfile::tempdir().unwrap();
    let a = team(dir.path(), "a");
    let a_admin = admin_of(&a, "ada@example.org").await;
    let hash = attach(&a, &a_admin).await;
    let file = dir.path().join("cli.infall");
    let out = std::process::Command::new(BIN)
        .arg("export-workspace")
        .arg(&file)
        .env("QOOP_DB", dir.path().join("a.db"))
        .env("RUST_LOG", "warn")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(contains(&std::fs::read(&file).unwrap(), MARK));

    let c_db = dir.path().join("c.db");
    {
        let store = SqliteStore::open(&c_db).unwrap();
        qoop_server::create_admin(&store, "cy@example.org", "Cy", PASSWORD, START).unwrap();
    }
    let out = std::process::Command::new(BIN)
        .arg("import-workspace")
        .arg(&file)
        .args(["--admin-email", "cy@example.org"])
        .env("QOOP_DB", &c_db)
        .env("RUST_LOG", "warn")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let store = SqliteStore::open(&c_db).unwrap();
    assert_eq!(
        store.pdf_file(&hash).unwrap().unwrap().size,
        the_pdf().len() as u64
    );
    assert_eq!(
        store.pdf_text(&hash).unwrap().unwrap()[1],
        format!("page two {TEXT_MARK}")
    );
}
