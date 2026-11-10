//! M12 — Local Workspaces (docs/specs/local.md, Contracts A and B; api.md §16): the entry,
//! the `/api/local/*` endpoints, what is refused, and what each Preset seeds.

mod common;

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::http::{Method, StatusCode, header};
use common::{ORIGIN, START, TestApp, new_id, web_dir};
use qoop_server::Clock;
use qoop_server::local::{
    LOCAL_EMAIL, LocalOptions, Preset, build_local_app, local_config, secret_key_path, start_local,
};
use qoop_server::store::{MemoryStore, SqliteStore, Store, SuggestionState};
use serde_json::{Value, json};

/// A Local Workspace driven without a socket. Writes are sent the way `TestApp` sends them,
/// with `Origin: http://localhost:8787`, which these tests allow as the dev origin; the real
/// origin is checked in the socket test at the end.
struct Local {
    app: TestApp,
    key: String,
}

fn local_with(store: Arc<dyn Store>, preset: Preset, name: &str) -> Local {
    let web = web_dir();
    let mut config = local_config(([127, 0, 0, 1], 4321).into(), web.path().to_path_buf());
    config.dev_origin = Some(ORIGIN.to_string());
    let clock = Clock::manual(START);
    let built = build_local_app(config, store.clone(), clock.clone(), preset, name).unwrap();
    Local {
        app: TestApp {
            router: built.router,
            clock,
            store,
            web,
        },
        key: built.entry_key,
    }
}

fn local(preset: Preset) -> Local {
    local_with(Arc::new(MemoryStore::new()), preset, "Ada Lovelace")
}

impl Local {
    /// Enters with the right key; returns the session cookie.
    async fn enter(&self) -> String {
        let res = self
            .app
            .get(&format!("/api/local/enter?key={}", self.key), None)
            .await;
        assert_eq!(res.status, StatusCode::SEE_OTHER, "{}", res.text);
        assert_eq!(res.headers[header::LOCATION], "/");
        res.cookie()
    }
}

// ---------------------------------------------------------------- the entry

#[tokio::test]
async fn the_entry_with_the_key_signs_the_one_member_in() {
    let w = local(Preset::Blank);
    let cookie = w.enter().await;
    let me = w.app.get("/api/me", Some(&cookie)).await;
    assert_eq!(me.status, StatusCode::OK);
    assert_eq!(me.body["member"]["name"], "Ada Lovelace");
    assert_eq!(me.body["member"]["role"], "admin");
    assert_eq!(me.body["member"]["email"], LOCAL_EMAIL);
    let members = w.app.get("/api/members", Some(&cookie)).await;
    assert_eq!(members.body["members"].as_array().unwrap().len(), 1);
    // Entering again is another session for the same Member.
    let again = w.enter().await;
    assert_ne!(again, cookie);
    assert_eq!(
        w.app.get("/api/me", Some(&again)).await.body["member"]["id"],
        me.body["member"]["id"]
    );
}

#[tokio::test]
async fn a_wrong_or_missing_key_is_not_found() {
    let w = local(Preset::Blank);
    let mut wrong = w.key.clone();
    wrong.replace_range(0..1, if wrong.starts_with('A') { "B" } else { "A" });
    for path in [
        "/api/local/enter".to_string(),
        "/api/local/enter?".to_string(),
        "/api/local/enter?key=".to_string(),
        format!("/api/local/enter?key={wrong}"),
        format!("/api/local/enter?key={}x", w.key),
        format!("/api/local/enter?other={}", w.key),
        format!("/api/local/enter?key={}", &w.key[..w.key.len() - 1]),
    ] {
        let res = w.app.get(&path, None).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "{path}");
        assert_eq!(res.code(), "not_found");
        assert!(res.set_cookie().is_none(), "{path}");
    }
    // The key may come with other parameters.
    let res = w
        .app
        .get(&format!("/api/local/enter?x=1&key={}", w.key), None)
        .await;
    assert_eq!(res.status, StatusCode::SEE_OTHER);
}

#[tokio::test]
async fn each_start_has_its_own_key() {
    let store: Arc<dyn Store> = Arc::new(MemoryStore::new());
    let first = local_with(store.clone(), Preset::Blank, "Ada");
    let second = local_with(store, Preset::Blank, "Ada");
    assert_ne!(first.key, second.key);
    let res = second
        .app
        .get(&format!("/api/local/enter?key={}", first.key), None)
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_local_workspace_has_a_session_cookie_name_of_its_own() {
    let w = local(Preset::Blank);
    let cookie = w.enter().await;
    let (name, token) = cookie.split_once('=').unwrap();
    assert!(
        name.starts_with("qoop_session_") && name.len() > "qoop_session_".len(),
        "{name}"
    );
    // Kept: every entry uses the same name.
    assert_eq!(w.enter().await.split('=').next().unwrap(), name);
    // When the session is extended, the cookie is sent again under the same name.
    w.app.clock.advance(2 * 24 * 60 * 60 * 1000);
    let res = w.app.get("/api/me", Some(&cookie)).await;
    assert_eq!(res.status, StatusCode::OK);
    let set = res.set_cookie().expect("the cookie, sent again");
    assert!(set.starts_with(&format!("{name}={token};")), "{set}");
    // Another Workspace (another database), another name.
    let other = local(Preset::Blank);
    assert_ne!(other.enter().await.split('=').next().unwrap(), name);
    // The same database started again: the same name.
    let store = w.app.store.clone();
    let again = local_with(store, Preset::Blank, "Ada Lovelace");
    assert_eq!(again.enter().await.split('=').next().unwrap(), name);
}

#[tokio::test]
async fn a_stale_cookie_under_the_old_name_is_ignored_in_a_local_workspace() {
    let w = local(Preset::Blank);
    let cookie = w.enter().await;
    let (_, token) = cookie.split_once('=').unwrap();
    // Beside the right one: no error, still signed in.
    for both in [
        format!("qoop_session=stale; {cookie}"),
        format!("{cookie}; qoop_session=stale"),
    ] {
        let res = w.app.get("/api/me", Some(&both)).await;
        assert_eq!(res.status, StatusCode::OK, "{both}: {}", res.text);
        assert!(res.set_cookie().is_none());
    }
    // Alone it signs no one in, whatever it carries — even this Workspace's own token.
    for stale in [
        "qoop_session=stale".to_string(),
        format!("qoop_session={token}"),
    ] {
        let res = w.app.get("/api/me", Some(&stale)).await;
        assert_eq!(res.status, StatusCode::UNAUTHORIZED, "{stale}");
        assert_eq!(res.code(), "not_signed_in");
    }
}

#[tokio::test]
async fn a_team_workspace_keeps_the_cookie_name_qoop_session() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let (name, token) = admin.split_once('=').unwrap();
    assert_eq!(name, "qoop_session");
    assert_eq!(
        app.get("/api/me", Some(&admin)).await.status,
        StatusCode::OK
    );
    // A Local Workspace's kind of name means nothing to a Team server.
    let res = app
        .get(
            "/api/me",
            Some(&format!("qoop_session_abcdefghijklmnop={token}")),
        )
        .await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
}

// ---------------------------------------------------------------- GET /api/workspace

#[tokio::test]
async fn the_workspace_says_local_and_its_preset() {
    for preset in Preset::ALL {
        let w = local(preset);
        let cookie = w.enter().await;
        let res = w.app.get("/api/workspace", Some(&cookie)).await;
        assert_eq!(res.status, StatusCode::OK);
        assert_eq!(
            res.body,
            json!({ "kind": "local", "preset": preset.id(), "empty": false, "read_only": false })
        );
    }
    let w = local(Preset::Blank);
    assert_eq!(
        w.app.get("/api/workspace", None).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn a_team_workspace_says_team_to_members_and_guests() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let guest = app
        .join(&admin, "g@example.org", "guest", Some(START + 1_000_000))
        .await;
    for cookie in [&admin, &guest] {
        let res = app.get("/api/workspace", Some(cookie)).await;
        assert_eq!(res.status, StatusCode::OK);
        assert_eq!(
            res.body,
            json!({ "kind": "team", "preset": null, "empty": true, "read_only": false })
        );
    }
    assert_eq!(
        app.get("/api/workspace", None).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn every_local_path_is_not_found_on_a_team_workspace() {
    let app = TestApp::new();
    let admin = app.admin().await;
    for cookie in [None, Some(admin.as_str())] {
        let gets = [
            "/api/local/enter",
            "/api/local/enter?key=anything",
            "/api/local/tutorial",
            "/api/local/member",
            "/api/local/other",
        ];
        for path in gets {
            let res = app.get(path, cookie).await;
            assert_eq!(res.status, StatusCode::NOT_FOUND, "GET {path}");
            assert_eq!(res.code(), "not_found");
        }
        let res = app
            .write(
                Method::PATCH,
                "/api/local/member",
                cookie,
                json!({ "name": "Eve" }),
            )
            .await;
        assert_eq!(res.status, StatusCode::NOT_FOUND);
        let res = app
            .put("/api/local/tutorial", cookie, json!({ "state": {} }))
            .await;
        assert_eq!(res.status, StatusCode::NOT_FOUND);
    }
}

// ---------------------------------------------------------------- PATCH /api/local/member

#[tokio::test]
async fn the_member_can_change_their_name() {
    let w = local(Preset::Blank);
    let cookie = w.enter().await;
    let res = w
        .app
        .write(
            Method::PATCH,
            "/api/local/member",
            Some(&cookie),
            json!({ "name": "  Bea  " }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body, json!({ "name": "Bea" }));
    assert_eq!(
        w.app.get("/api/me", Some(&cookie)).await.body["member"]["name"],
        "Bea"
    );

    for bad in [
        json!({ "name": "  " }),
        json!({ "name": "x".repeat(101) }),
        json!({ "name": "a\u{7}b" }),
        json!({}),
    ] {
        let res = w
            .app
            .write(Method::PATCH, "/api/local/member", Some(&cookie), bad)
            .await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{}", res.text);
        assert_eq!(res.code(), "bad_request");
    }
    let res = w
        .app
        .write(
            Method::PATCH,
            "/api/local/member",
            None,
            json!({ "name": "Eve" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        w.app.get("/api/me", Some(&cookie)).await.body["member"]["name"],
        "Bea"
    );
}

#[tokio::test]
async fn an_unusable_name_at_creation_becomes_me() {
    let w = local_with(Arc::new(MemoryStore::new()), Preset::Blank, "   ");
    let cookie = w.enter().await;
    assert_eq!(
        w.app.get("/api/me", Some(&cookie)).await.body["member"]["name"],
        "Me"
    );
}

// ---------------------------------------------------------------- /api/local/tutorial

#[tokio::test]
async fn the_tutorial_state_is_kept_exactly_as_sent() {
    let w = local(Preset::Tutorial);
    let cookie = w.enter().await;
    let res = w.app.get("/api/local/tutorial", Some(&cookie)).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body, json!({ "state": null }));

    // Sent as raw text, so the order of keys and the spelling of numbers can be checked.
    let raw = r#"{"zeta":1,"alpha":[1.50,{"b":true,"a":null}],"step":"merge"}"#;
    let res = w
        .app
        .write_raw(
            Method::PUT,
            "/api/local/tutorial",
            &cookie,
            format!(r#"{{"state":{raw}}}"#),
        )
        .await;
    assert_eq!(res.status, StatusCode::NO_CONTENT, "{}", res.text);
    assert!(res.text.is_empty());
    let res = w.app.get("/api/local/tutorial", Some(&cookie)).await;
    assert_eq!(res.text, format!(r#"{{"state":{raw}}}"#));

    // Any JSON, null included.
    for state in [json!(3), json!("text"), json!([1, 2]), Value::Null] {
        let res = w
            .app
            .put(
                "/api/local/tutorial",
                Some(&cookie),
                json!({ "state": state }),
            )
            .await;
        assert_eq!(res.status, StatusCode::NO_CONTENT);
        let res = w.app.get("/api/local/tutorial", Some(&cookie)).await;
        assert_eq!(res.body, json!({ "state": state }));
    }

    // Without `state`, or not JSON: refused, and what was stored stays.
    w.app
        .put(
            "/api/local/tutorial",
            Some(&cookie),
            json!({ "state": { "kept": 1 } }),
        )
        .await;
    for body in [json!({}), json!({ "other": 1 })] {
        let res = w.app.put("/api/local/tutorial", Some(&cookie), body).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST);
    }
    let res = w
        .app
        .write_raw(
            Method::PUT,
            "/api/local/tutorial",
            &cookie,
            "{\"state\":".to_string(),
        )
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        w.app.get("/api/local/tutorial", Some(&cookie)).await.body,
        json!({ "state": { "kept": 1 } })
    );

    assert_eq!(
        w.app.get("/api/local/tutorial", None).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn the_tutorial_state_is_at_most_16_kib() {
    let w = local(Preset::Tutorial);
    let cookie = w.enter().await;
    let wrapper = r#"{"state":""}"#.len();
    let fits = format!(r#"{{"state":"{}"}}"#, "x".repeat(16 * 1024 - wrapper));
    assert_eq!(fits.len(), 16 * 1024);
    let res = w
        .app
        .write_raw(Method::PUT, "/api/local/tutorial", &cookie, fits)
        .await;
    assert_eq!(res.status, StatusCode::NO_CONTENT, "{}", res.text);

    let over = format!(r#"{{"state":"{}"}}"#, "y".repeat(16 * 1024 - wrapper + 1));
    let res = w
        .app
        .write_raw(Method::PUT, "/api/local/tutorial", &cookie, over)
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.code(), "bad_request");
    let kept = w.app.get("/api/local/tutorial", Some(&cookie)).await;
    assert!(kept.body["state"].as_str().unwrap().starts_with('x'));
}

#[tokio::test]
async fn the_tutorial_state_is_kept_in_the_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.db");
    {
        let store: Arc<dyn Store> = Arc::new(SqliteStore::open(&path).unwrap());
        let w = local_with(store, Preset::Tutorial, "Ada");
        let cookie = w.enter().await;
        let res = w
            .app
            .put(
                "/api/local/tutorial",
                Some(&cookie),
                json!({ "state": { "step": 7 } }),
            )
            .await;
        assert_eq!(res.status, StatusCode::NO_CONTENT);
    }
    let store: Arc<dyn Store> = Arc::new(SqliteStore::open(&path).unwrap());
    let w = local_with(store, Preset::Blank, "Someone else");
    let cookie = w.enter().await;
    assert_eq!(
        w.app.get("/api/local/tutorial", Some(&cookie)).await.body,
        json!({ "state": { "step": 7 } })
    );
    assert_eq!(
        w.app.get("/api/workspace", Some(&cookie)).await.body,
        json!({ "kind": "local", "preset": "tutorial", "empty": false, "read_only": false })
    );
}

// ---------------------------------------------------------------- refusals

#[tokio::test]
async fn what_needs_a_team_is_refused() {
    let w = local(Preset::Blank);
    let cookie = w.enter().await;
    let me = w.app.get("/api/me", Some(&cookie)).await.body["member"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let refused = [
        (
            w.app
                .post(
                    "/api/invites",
                    Some(&cookie),
                    json!({ "email": "bea@example.org", "role": "member" }),
                )
                .await,
            "create an invite",
        ),
        (
            w.app
                .delete(&format!("/api/invites/{}", new_id()), Some(&cookie))
                .await,
            "revoke an invite",
        ),
        (
            w.app
                .delete(&format!("/api/members/{}", new_id()), Some(&cookie))
                .await,
            "remove a Member",
        ),
        (
            w.app
                .delete(&format!("/api/members/{me}"), Some(&cookie))
                .await,
            "remove oneself",
        ),
        (
            w.app
                .post(
                    "/api/auth/login",
                    None,
                    json!({ "email": LOCAL_EMAIL, "password": "a long enough password" }),
                )
                .await,
            "sign in with a password",
        ),
        (
            w.app
                .post("/api/auth/logout", Some(&cookie), json!({}))
                .await,
            "sign out",
        ),
    ];
    for (res, what) in refused {
        assert_eq!(res.status, StatusCode::FORBIDDEN, "{what}: {}", res.text);
        assert_eq!(res.code(), "forbidden", "{what}");
        assert!(!res.body["error"]["message"].as_str().unwrap().is_empty());
        assert!(res.set_cookie().is_none(), "{what}");
    }
    // Still signed in, still one Member, no invite.
    assert_eq!(
        w.app.get("/api/me", Some(&cookie)).await.status,
        StatusCode::OK
    );
    assert_eq!(w.app.store.members().unwrap().len(), 1);
    assert!(w.app.store.pending_invites(START).unwrap().is_empty());
    // Reading the (empty) list of invites is not a change, and stays allowed.
    let res = w.app.get("/api/invites", Some(&cookie)).await;
    assert_eq!(res.body, json!({ "invites": [] }));
}

#[tokio::test]
async fn a_team_workspace_still_signs_in_out_and_invites() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let token = app.invite(&admin, "bea@example.org", "member", None).await;
    assert!(!token.is_empty());
    let res = app.post("/api/auth/logout", Some(&admin), json!({})).await;
    assert_eq!(res.status, StatusCode::OK);
}

// ---------------------------------------------------------------- what each Preset seeds

/// The Board of `main` and every other Branch, read through the API.
struct Seeded {
    member: String,
    main: String,
    branches: Vec<Value>,
    board: BTreeMap<String, Value>,
}

impl Seeded {
    async fn read(w: &Local, cookie: &str) -> Seeded {
        let member = w.app.get("/api/me", Some(cookie)).await.body["member"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let branches = w.app.get("/api/branches", Some(cookie)).await.body["branches"]
            .as_array()
            .unwrap()
            .clone();
        let main = w.app.main_branch(cookie).await;
        let res = w
            .app
            .get(&format!("/api/branches/{main}/board"), Some(cookie))
            .await;
        let board = res.body["entities"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        Seeded {
            member,
            main,
            branches,
            board,
        }
    }

    fn of_kind<'a>(&'a self, kind: &'a str) -> impl Iterator<Item = (&'a String, &'a Value)> {
        self.board
            .iter()
            .filter(move |(_, e)| e["kind"] == kind && e["deleted"] == false)
    }

    fn titles(&self, kind: &str) -> Vec<String> {
        let mut t: Vec<String> = self
            .of_kind(kind)
            .map(|(_, e)| text(e, "title").to_string())
            .collect();
        t.sort();
        t
    }

    fn by_title(&self, kind: &str, title: &str) -> (String, Value) {
        let found: Vec<_> = self
            .of_kind(kind)
            .filter(|(_, e)| text(e, "title") == title)
            .collect();
        assert_eq!(found.len(), 1, "one {kind} titled {title:?}");
        (found[0].0.clone(), found[0].1.clone())
    }

    /// The live Blocks of a Card's Page, in order.
    fn page(&self, card: &str) -> Vec<Value> {
        let mut blocks: Vec<Value> = self
            .of_kind("Block")
            .filter(|(_, e)| e["fields"]["card"]["Ref"] == card)
            .map(|(_, e)| e.clone())
            .collect();
        blocks.sort_by_key(|b| text(b, "order").to_string());
        blocks
    }

    fn sources_of(&self, card: &str) -> usize {
        self.of_kind("Attachment")
            .filter(|(_, e)| e["fields"]["card"]["Ref"] == card)
            .count()
    }

    /// The title of the Frame whose rectangle holds the Card's centre.
    fn frame_of(&self, card: &Value) -> Option<String> {
        let (cx, cy) = (num(card, "x") + 224.0 / 2.0, num(card, "y") + 132.0 / 2.0);
        self.of_kind("Frame")
            .find(|(_, f)| {
                cx >= num(f, "x")
                    && cx <= num(f, "x") + num(f, "w")
                    && cy >= num(f, "y")
                    && cy <= num(f, "y") + num(f, "h")
            })
            .map(|(_, f)| text(f, "title").to_string())
    }
}

fn text<'a>(e: &'a Value, field: &str) -> &'a str {
    e["fields"][field]["Text"].as_str().unwrap_or("")
}

fn num(e: &Value, field: &str) -> f64 {
    e["fields"][field]["Float"].as_f64().unwrap_or(0.0)
}

/// Every Change on every Branch is by the one Member.
async fn all_changes_by(w: &Local, cookie: &str, s: &Seeded) {
    for b in &s.branches {
        let id = b["id"].as_str().unwrap();
        let res = w
            .app
            .get(&format!("/api/branches/{id}/changes?after=0"), Some(cookie))
            .await;
        for c in res.body["changes"].as_array().unwrap() {
            assert_eq!(c["author"], s.member.as_str());
            assert_eq!(c["origin"], "Edit");
        }
    }
}

#[tokio::test]
async fn blank_seeds_nothing() {
    let w = local(Preset::Blank);
    let cookie = w.enter().await;
    let s = Seeded::read(&w, &cookie).await;
    assert_eq!(s.branches.len(), 1);
    assert_eq!(s.branches[0]["name"], "main");
    assert_eq!(s.branches[0]["seq"], 0);
    assert!(s.board.is_empty());
    assert!(w.app.store.todos().unwrap().is_empty());
    let res = w
        .app
        .get(
            &format!("/api/suggestions?branch={}", s.main),
            Some(&cookie),
        )
        .await;
    assert_eq!(res.body, json!({ "suggestions": [] }));
}

#[tokio::test]
async fn literature_review_seeds_its_frames_and_example_cards() {
    let w = local(Preset::LiteratureReview);
    let cookie = w.enter().await;
    let s = Seeded::read(&w, &cookie).await;
    assert_eq!(s.branches.len(), 1);
    assert_eq!(
        s.titles("Frame"),
        ["Key findings", "Open questions", "Reading", "To read"]
    );
    let cards: Vec<_> = s.of_kind("Card").collect();
    assert!((3..=4).contains(&cards.len()), "{}", cards.len());
    for (id, card) in &cards {
        assert!(
            s.frame_of(card).is_some(),
            "{} sits in a Frame",
            text(card, "title")
        );
        assert!(!text(card, "summary").is_empty());
        let _ = id;
    }
    let with_source = cards.iter().filter(|(id, _)| s.sources_of(id) > 0).count();
    assert_eq!(with_source, 1);
    assert!(w.app.store.todos().unwrap().is_empty());
    all_changes_by(&w, &cookie, &s).await;
}

#[tokio::test]
async fn research_project_seeds_its_frames_and_a_run_with_its_output() {
    let w = local(Preset::ResearchProject);
    let cookie = w.enter().await;
    let s = Seeded::read(&w, &cookie).await;
    assert_eq!(s.branches.len(), 1);
    assert_eq!(
        s.titles("Frame"),
        ["Experiments", "Hypotheses", "Questions", "Results"]
    );
    let cards: Vec<_> = s.of_kind("Card").collect();
    assert!(cards.len() >= 3);
    let runs: Vec<_> = s
        .of_kind("Block")
        .filter(|(_, b)| text(b, "type") == "run")
        .collect();
    assert_eq!(runs.len(), 1);
    let run = runs[0].1;
    let card = &s.board[run["fields"]["card"]["Ref"].as_str().unwrap()];
    assert_eq!(s.frame_of(card).as_deref(), Some("Experiments"));
    check_run(run, &s.member);
    all_changes_by(&w, &cookie, &s).await;
}

/// A Run whose code uses only Python's standard library, with a §15 result recorded by
/// `member` for exactly that code; when `python3` is there, the code is executed and must
/// print what was captured, within two seconds.
fn check_run(run: &Value, member: &str) {
    let code = text(run, "text");
    for line in code
        .lines()
        .filter(|l| l.starts_with("import") || l.starts_with("from"))
    {
        let module = line.split_whitespace().nth(1).unwrap();
        assert!(["random", "math", "statistics"].contains(&module), "{line}");
    }
    let result: Value = serde_json::from_str(text(run, "result")).unwrap();
    assert_eq!(result["v"], 1);
    assert_eq!(result["by"], member);
    assert_eq!(result["exit"], 0);
    assert!(result["duration_ms"].as_u64().unwrap() < 2000);
    let sha: String = <sha2::Sha256 as sha2::Digest>::digest(code.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(result["code_sha256"], sha);
    let output = result["output"].as_str().unwrap();
    assert!(!output.is_empty());

    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("run.py");
    std::fs::write(&file, code).unwrap();
    // The time asked of the processor, which the other work on a busy machine does not
    // stretch the way it stretches the time on the clock.
    const TIMED: &str = "import runpy, sys, time; runpy.run_path(sys.argv[1], run_name='__main__'); print(time.process_time(), file=sys.stderr)";
    match std::process::Command::new("python3")
        .args(["-I", "-c", TIMED])
        .arg(&file)
        .output()
    {
        Ok(out) => {
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            assert_eq!(String::from_utf8_lossy(&out.stdout), output);
            let cpu: f64 = String::from_utf8_lossy(&out.stderr).trim().parse().unwrap();
            assert!(cpu < 2.0, "{cpu} s");
        }
        Err(e) => eprintln!("python3 is not available ({e}); the Run was not executed"),
    }
}

#[tokio::test]
async fn tutorial_seeds_the_sample_board() {
    let w = local(Preset::Tutorial);
    let cookie = w.enter().await;
    let s = Seeded::read(&w, &cookie).await;

    // Frames, and the named Cards in them.
    assert_eq!(s.titles("Frame"), ["Experiments", "Papers", "Start here"]);
    let (welcome, welcome_card) = s.by_title("Card", "Welcome to Infall");
    let (walk, walk_card) = s.by_title("Card", "Random walk experiment");
    let (watch, watch_card) = s.by_title("Card", "Watch a walk");
    assert_eq!(s.frame_of(&welcome_card).as_deref(), Some("Start here"));
    assert_eq!(s.frame_of(&walk_card).as_deref(), Some("Experiments"));
    assert_eq!(s.frame_of(&watch_card).as_deref(), Some("Experiments"));
    let papers: Vec<String> = s
        .of_kind("Card")
        .filter(|(_, c)| s.frame_of(c).as_deref() == Some("Papers"))
        .map(|(id, _)| id.clone())
        .collect();
    assert!((2..=3).contains(&papers.len()), "{}", papers.len());
    assert!(papers.iter().any(|p| s.sources_of(p) > 0));
    assert!(
        s.of_kind("Card")
            .all(|(_, c)| text(c, "title") != "Walks of 10 000 steps"),
        "that Card is only on longer-walks"
    );

    // The welcome Page: text with a formula.
    let page = s.page(&welcome);
    assert!(!page.is_empty());
    assert!(page.iter().all(|b| text(b, "type") == "text"));
    assert!(page.iter().any(|b| text(b, "text").contains("$$")));

    // The Run, with its captured output.
    let runs: Vec<Value> = s
        .page(&walk)
        .into_iter()
        .filter(|b| text(b, "type") == "run")
        .collect();
    assert_eq!(runs.len(), 1);
    check_run(&runs[0], &s.member);
    assert!(text(&runs[0], "result").contains("mean R^2"));

    // The Visual, in the format the web UI's Visuals use: HTML with a script.
    let visuals: Vec<Value> = s
        .page(&watch)
        .into_iter()
        .filter(|b| text(b, "type") == "visual")
        .collect();
    assert_eq!(visuals.len(), 1);
    let html = text(&visuals[0], "text");
    assert!(html.contains("<canvas") && html.contains("<script>"));
    assert!(html.contains("var(--q-"));
    assert!(!html.contains("http"), "a Visual has no network");

    // Connections: every kind, one with a label.
    let connections: Vec<_> = s.of_kind("Connection").map(|(_, c)| c).collect();
    for kind in ["related", "directed", "contradicts"] {
        assert!(
            connections.iter().any(|c| text(c, "kind") == kind),
            "a {kind} Connection"
        );
    }
    assert!(connections.iter().any(|c| !text(c, "label").is_empty()));

    // Exactly one pending Suggestion: a Connection between two Papers Cards.
    let res = w
        .app
        .get(
            &format!("/api/suggestions?branch={}", s.main),
            Some(&cookie),
        )
        .await;
    let suggestions = res.body["suggestions"].as_array().unwrap();
    assert_eq!(suggestions.len(), 1);
    let sug = &suggestions[0];
    assert_eq!(sug["state"], "pending");
    assert_eq!(sug["kind"], "connection");
    let (from, to) = (
        sug["connection"]["from"].as_str().unwrap().to_string(),
        sug["connection"]["to"].as_str().unwrap().to_string(),
    );
    assert!(papers.contains(&from) && papers.contains(&to) && from != to);
    assert!(
        !connections.iter().any(|c| {
            let ends = [
                c["fields"]["from"]["Ref"].as_str().unwrap(),
                c["fields"]["to"]["Ref"].as_str().unwrap(),
            ];
            ends.contains(&from.as_str()) && ends.contains(&to.as_str())
        }),
        "the suggested Connection is not drawn yet"
    );

    // The To-do, owned by the Member, pointing at the welcome Card.
    let res = w.app.get("/api/todos", Some(&cookie)).await;
    let todos = res.body["todos"].as_array().unwrap();
    assert_eq!(todos.len(), 1);
    assert_eq!(todos[0]["text"], "Read the welcome Card");
    assert_eq!(todos[0]["owner"], s.member.as_str());
    assert_eq!(todos[0]["done"], false);
    assert_eq!(todos[0]["card"]["id"], welcome.as_str());
    assert_eq!(todos[0]["card"]["title"], "Welcome to Infall");
    assert_eq!(todos[0]["card"]["branch"], s.main.as_str());

    // The Checkpoint on main, and longer-walks made from it.
    let res = w
        .app
        .get(
            &format!("/api/branches/{}/checkpoints", s.main),
            Some(&cookie),
        )
        .await;
    let checkpoints = res.body["checkpoints"].as_array().unwrap();
    assert_eq!(checkpoints.len(), 1);
    let checkpoint = &checkpoints[0];
    assert_eq!(checkpoint["name"], "Before the tutorial");
    assert_eq!(checkpoint["author"], s.member.as_str());
    assert_eq!(s.branches.len(), 2);
    let longer = s
        .branches
        .iter()
        .find(|b| b["name"] == "longer-walks")
        .unwrap();
    assert_eq!(longer["parent"], checkpoint["moment"]);
    assert_eq!(longer["created_by"], s.member.as_str());
    let main_info = s.branches.iter().find(|b| b["name"] == "main").unwrap();
    // main changed once after the Checkpoint: the summary of the Run Card.
    assert_eq!(
        main_info["seq"].as_u64().unwrap(),
        checkpoint["moment"]["seq"].as_u64().unwrap() + 1
    );
    let at_checkpoint = w
        .app
        .get(
            &format!(
                "/api/branches/{}/board?at={}",
                s.main, checkpoint["moment"]["seq"]
            ),
            Some(&cookie),
        )
        .await;
    assert_ne!(
        text(&at_checkpoint.body["entities"][&walk], "summary"),
        text(&walk_card, "summary")
    );

    all_changes_by(&w, &cookie, &s).await;
}

#[tokio::test]
async fn merging_longer_walks_into_main_has_exactly_one_conflict() {
    let w = local(Preset::Tutorial);
    let cookie = w.enter().await;
    let s = Seeded::read(&w, &cookie).await;
    let longer = s
        .branches
        .iter()
        .find(|b| b["name"] == "longer-walks")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let (walk, _) = s.by_title("Card", "Random walk experiment");

    let res = w
        .app
        .get(
            &format!("/api/merges/plan?source={longer}&target={}", s.main),
            Some(&cookie),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let plan = res.body["plan"].clone();
    let conflicts = plan["conflicts"].as_array().unwrap();
    assert_eq!(conflicts.len(), 1, "{plan}");
    let field = &conflicts[0]["Field"];
    assert_eq!(field["entity"], walk.as_str());
    assert_eq!(field["field"], "summary");
    assert_ne!(field["source"], field["target"]);
    let auto = plan["auto"].as_array().unwrap();
    assert_eq!(auto.len(), 1, "one clean addition: {plan}");
    let create = &auto[0]["Create"];
    assert_eq!(create["kind"], "Card");
    assert_eq!(create["fields"]["title"]["Text"], "Walks of 10 000 steps");

    // Deciding the Conflict lands the Merge.
    let res = w
        .app
        .post(
            "/api/merges",
            Some(&cookie),
            json!({
                "plan": plan,
                "decisions": [[{ "entity": walk, "field": "summary" }, "TakeSource"]],
            }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let after = Seeded::read(&w, &cookie).await;
    let (_, walk_card) = after.by_title("Card", "Random walk experiment");
    assert_eq!(
        field["source"]["Text"].as_str().unwrap(),
        text(&walk_card, "summary")
    );
    let (_, added) = after.by_title("Card", "Walks of 10 000 steps");
    assert_eq!(after.frame_of(&added).as_deref(), Some("Experiments"));
}

#[tokio::test]
async fn accepting_the_tutorial_suggestion_works() {
    let w = local(Preset::Tutorial);
    let cookie = w.enter().await;
    let s = Seeded::read(&w, &cookie).await;
    let res = w
        .app
        .get(
            &format!("/api/suggestions?branch={}", s.main),
            Some(&cookie),
        )
        .await;
    let sug = res.body["suggestions"][0].clone();
    let c = &sug["connection"];
    let op = json!({ "Create": { "entity": new_id(), "kind": "Connection", "fields": {
        "from": { "Ref": c["from"] }, "to": { "Ref": c["to"] },
        "kind": { "Text": c["kind"] }, "label": { "Text": c["label"] } } } });
    let res = w
        .app
        .post(
            &format!("/api/suggestions/{}/accept", sug["id"].as_str().unwrap()),
            Some(&cookie),
            json!({ "ops": [op] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let id = uuid::Uuid::parse_str(sug["id"].as_str().unwrap()).unwrap();
    assert_eq!(
        w.app.store.suggestion(id).unwrap().unwrap().state,
        SuggestionState::Accepted
    );
}

#[tokio::test]
async fn a_prepared_database_is_never_seeded_again() {
    let store: Arc<dyn Store> = Arc::new(MemoryStore::new());
    let first = local_with(store.clone(), Preset::Tutorial, "Ada");
    let cookie = first.enter().await;
    let before = Seeded::read(&first, &cookie).await;
    let seq: Vec<Value> = before.branches.iter().map(|b| b["seq"].clone()).collect();

    // Another start with another Preset and name: both ignored.
    let second = local_with(store.clone(), Preset::ResearchProject, "Someone else");
    let cookie = second.enter().await;
    let after = Seeded::read(&second, &cookie).await;
    assert_eq!(
        after
            .branches
            .iter()
            .map(|b| b["seq"].clone())
            .collect::<Vec<_>>(),
        seq
    );
    assert_eq!(after.member, before.member);
    assert_eq!(store.members().unwrap().len(), 1);
    assert_eq!(store.members().unwrap()[0].name, "Ada");
    assert_eq!(store.todos().unwrap().len(), 1);
    assert_eq!(
        second.app.get("/api/workspace", Some(&cookie)).await.body,
        json!({ "kind": "local", "preset": "tutorial", "empty": false, "read_only": false })
    );
}

#[tokio::test]
async fn the_seeded_workspace_survives_in_sqlite() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.db");
    let store: Arc<dyn Store> = Arc::new(SqliteStore::open(&path).unwrap());
    let w = local_with(store, Preset::Tutorial, "Ada");
    let cookie = w.enter().await;
    let before = Seeded::read(&w, &cookie).await;
    drop(w);
    let store: Arc<dyn Store> = Arc::new(SqliteStore::open(&path).unwrap());
    let w = local_with(store, Preset::Blank, "Ada");
    let cookie = w.enter().await;
    let after = Seeded::read(&w, &cookie).await;
    assert_eq!(after.board, before.board);
    assert_eq!(after.branches, before.branches);
}

// ---------------------------------------------------------------- start_local, on a socket

#[tokio::test]
async fn start_local_serves_on_127_0_0_1_until_stopped() {
    let dir = tempfile::tempdir().unwrap();
    let web = web_dir();
    let db = dir.path().join("ws").join("workspace.db");
    let options = LocalOptions {
        db: db.clone(),
        web_dir: web.path().to_path_buf(),
        preset: Preset::Tutorial,
        member_name: "Ada".to_string(),
        port: None,
        read_only: false,
        moved_to: None,
    };
    let server = start_local(options.clone()).await.unwrap();
    let origin = server.origin().to_string();
    let port = origin
        .strip_prefix("http://127.0.0.1:")
        .expect("an origin on 127.0.0.1")
        .parse::<u16>()
        .unwrap();
    assert_ne!(port, 0);
    let entry = server.entry_url().to_string();
    let key = entry
        .strip_prefix(&format!("{origin}/api/local/enter?key="))
        .expect("the entry URL")
        .to_string();
    assert_eq!(
        base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, &key)
            .unwrap()
            .len(),
        32
    );
    assert!(!format!("{server:?}").contains(&key));

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let wrong = client
        .get(format!("{origin}/api/local/enter?key=nope"))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), reqwest::StatusCode::NOT_FOUND);
    let res = client.get(&entry).send().await.unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::SEE_OTHER);
    assert_eq!(res.headers()[reqwest::header::LOCATION], "/");
    let cookie = res.headers()[reqwest::header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let cookie_name = cookie.split('=').next().unwrap().to_string();
    assert!(cookie_name.starts_with("qoop_session_"), "{cookie_name}");

    let me: Value = client
        .get(format!("{origin}/api/me"))
        .header(reqwest::header::COOKIE, &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(me["member"]["name"], "Ada");
    let ws: Value = client
        .get(format!("{origin}/api/workspace"))
        .header(reqwest::header::COOKIE, &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        ws,
        json!({ "kind": "local", "preset": "tutorial", "empty": false, "read_only": false })
    );

    // A write from the server's own origin passes the Origin check; from another it does not.
    let rename = |from: &str| {
        client
            .patch(format!("{origin}/api/local/member"))
            .header(reqwest::header::COOKIE, &cookie)
            .header(reqwest::header::ORIGIN, from)
            .header("x-qoop-request", "1")
            .json(&json!({ "name": "Bea" }))
            .send()
    };
    let res = rename("http://localhost:8787").await.unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::FORBIDDEN);
    let res = rename(&origin).await.unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::OK);

    // The OpenRouter path is on: there is a secret key, kept beside the database.
    let ai: Value = client
        .get(format!("{origin}/api/ai/status"))
        .header(reqwest::header::COOKIE, &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(ai["enabled"], true);
    let key_file = secret_key_path(&db);
    let key_text = std::fs::read_to_string(&key_file).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&key_file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    // The UI is served too.
    let page = client.get(format!("{origin}/")).send().await.unwrap();
    assert_eq!(page.status(), reqwest::StatusCode::OK);

    // A live connection does not hold up `stop`.
    let (_socket, _) = tokio_tungstenite::connect_async(
        tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(format!(
            "ws://127.0.0.1:{port}/api/ws"
        ))
        .map(|mut r| {
            r.headers_mut().insert("cookie", cookie.parse().unwrap());
            r.headers_mut().insert("origin", origin.parse().unwrap());
            r
        })
        .unwrap(),
    )
    .await
    .unwrap();
    let started = std::time::Instant::now();
    server.stop().await;
    assert!(started.elapsed().as_secs() < 5, "{:?}", started.elapsed());
    assert!(
        client
            .get(format!("{origin}/api/health"))
            .send()
            .await
            .is_err(),
        "nothing listens after stop"
    );

    // Started again: the same Workspace and secret key, a new port and key.
    let again = start_local(LocalOptions {
        preset: Preset::Blank,
        member_name: "Someone else".to_string(),
        ..options
    })
    .await
    .unwrap();
    assert_ne!(again.entry_url(), entry);
    let res = client
        .get(format!("{}/api/local/enter?key={key}", again.origin()))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::NOT_FOUND);
    let res = client.get(again.entry_url()).send().await.unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::SEE_OTHER);
    let cookie = res.headers()[reqwest::header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let me: Value = client
        .get(format!("{}/api/me", again.origin()))
        .header(reqwest::header::COOKIE, &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(me["member"]["name"], "Bea");
    assert_eq!(std::fs::read_to_string(&key_file).unwrap(), key_text);
    // The same database: the same cookie name, whatever the port.
    assert_eq!(cookie.split('=').next().unwrap(), cookie_name);
    again.stop().await;
}

// ---------------------------------------------------------------- one cookie name per Workspace

/// What a browser (or the desktop app's web view) keeps for `127.0.0.1`: cookies are kept
/// by host and name, never by port, so every Local Workspace shares this one jar.
#[derive(Default)]
struct Jar(std::sync::Mutex<BTreeMap<String, String>>);

impl Jar {
    fn take(&self, res: &reqwest::Response) {
        let mut jar = self.0.lock().unwrap();
        for set in res.headers().get_all(reqwest::header::SET_COOKIE) {
            let set = set.to_str().unwrap();
            let (name, value) = set.split(';').next().unwrap().split_once('=').unwrap();
            if value.is_empty() || set.contains("Max-Age=0") {
                jar.remove(name);
            } else {
                jar.insert(name.to_string(), value.to_string());
            }
        }
    }

    fn put(&self, name: &str, value: &str) {
        self.0
            .lock()
            .unwrap()
            .insert(name.to_string(), value.to_string());
    }

    fn header(&self) -> String {
        let jar = self.0.lock().unwrap();
        jar.iter()
            .map(|(n, v)| format!("{n}={v}"))
            .collect::<Vec<_>>()
            .join("; ")
    }

    fn names(&self) -> Vec<String> {
        self.0.lock().unwrap().keys().cloned().collect()
    }
}

async fn start_named(
    dir: &std::path::Path,
    name: &str,
    web: &std::path::Path,
) -> qoop_server::local::LocalServer {
    start_local(LocalOptions {
        db: dir.join(name).join("workspace.db"),
        web_dir: web.to_path_buf(),
        preset: Preset::Blank,
        member_name: name.to_string(),
        port: None,
        read_only: false,
        moved_to: None,
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn two_local_workspaces_at_once_keep_their_own_sign_in() {
    let dir = tempfile::tempdir().unwrap();
    let web = web_dir();
    let a = start_named(dir.path(), "Ada", web.path()).await;
    let b = start_named(dir.path(), "Bea", web.path()).await;
    assert_ne!(a.origin(), b.origin());
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let jar = Jar::default();
    // A stale cookie under the name of before, from some earlier version.
    jar.put("qoop_session", "left-over-from-before");

    // Ada's Workspace is entered, then Bea's: the second does not replace the first.
    let mut entered: Vec<(String, String)> = Vec::new();
    for server in [&a, &b] {
        let res = client.get(server.entry_url()).send().await.unwrap();
        assert_eq!(res.status(), reqwest::StatusCode::SEE_OTHER);
        let set = res.headers()[reqwest::header::SET_COOKIE].to_str().unwrap();
        let (name, token) = set.split(';').next().unwrap().split_once('=').unwrap();
        entered.push((name.to_string(), token.to_string()));
        jar.take(&res);
    }
    let names = jar.names();
    assert_eq!(names.len(), 3, "{names:?}");
    let local_names: Vec<&String> = names.iter().filter(|n| *n != "qoop_session").collect();
    assert_eq!(local_names.len(), 2);
    assert_ne!(local_names[0], local_names[1]);

    let me = |origin: String, cookie: String| {
        let client = client.clone();
        async move {
            let res = client
                .get(format!("{origin}/api/me"))
                .header(reqwest::header::COOKIE, cookie)
                .send()
                .await
                .unwrap();
            let status = res.status();
            let body: Value = res.json().await.unwrap();
            (status, body)
        }
    };
    // With everything in the jar, each server signs in its own Member, again and again.
    for _ in 0..2 {
        for (server, name) in [(&a, "Ada"), (&b, "Bea")] {
            let (status, body) = me(server.origin().to_string(), jar.header()).await;
            assert_eq!(status, reqwest::StatusCode::OK, "{body}");
            assert_eq!(body["member"]["name"], name);
        }
    }
    // The live connection too.
    for server in [&a, &b] {
        let origin = server.origin().to_string();
        let ws_url = format!("{}/api/ws", origin.replace("http://", "ws://"));
        let mut request =
            tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(ws_url)
                .unwrap();
        request
            .headers_mut()
            .insert("cookie", jar.header().parse().unwrap());
        request
            .headers_mut()
            .insert("origin", origin.parse().unwrap());
        let (socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        drop(socket);
    }

    // Each Workspace's cookie, alone, is refused by the other server: under its own name,
    // and under the other's.
    let [(name_a, token_a), (name_b, token_b)] = [&entered[0], &entered[1]].map(|c| c.clone());
    for (server, name, foreign_name, foreign_token) in [
        (&a, &name_a, &name_b, &token_b),
        (&b, &name_b, &name_a, &token_a),
    ] {
        for cookie in [
            format!("{foreign_name}={foreign_token}"),
            format!("{name}={foreign_token}"),
        ] {
            let (status, body) = me(server.origin().to_string(), cookie.clone()).await;
            assert_eq!(status, reqwest::StatusCode::UNAUTHORIZED, "{cookie}");
            assert_eq!(body["error"]["code"], "not_signed_in");
        }
    }
    // A Workspace's own token under the name of before is not read either, and is no error.
    for (server, token) in [(&a, &token_a), (&b, &token_b)] {
        let (status, body) = me(server.origin().to_string(), format!("qoop_session={token}")).await;
        assert_eq!(status, reqwest::StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"]["code"], "not_signed_in");
    }
    a.stop().await;
    b.stop().await;
}

#[tokio::test]
async fn a_broken_secret_key_file_stops_the_start() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("workspace.db");
    std::fs::write(secret_key_path(&db), "not a key").unwrap();
    let err = start_local(LocalOptions {
        db,
        web_dir: dir.path().to_path_buf(),
        preset: Preset::Blank,
        member_name: "Ada".to_string(),
        port: None,
        read_only: false,
        moved_to: None,
    })
    .await
    .unwrap_err();
    let message = err.to_string();
    assert!(message.contains("secret key file"), "{message}");
    assert!(!message.contains("not a key"));
}

#[tokio::test]
async fn start_local_can_be_spawned_and_its_server_shared() {
    fn shareable<T: Send + Sync + 'static>(_: &T) {}
    let dir = tempfile::tempdir().unwrap();
    let options = LocalOptions {
        db: dir.path().join("workspace.db"),
        web_dir: dir.path().to_path_buf(),
        preset: Preset::Blank,
        member_name: "Ada".to_string(),
        port: None,
        read_only: false,
        moved_to: None,
    };
    let server = tokio::spawn(start_local(options)).await.unwrap().unwrap();
    shareable(&server);
    server.stop().await;
}

#[tokio::test]
async fn start_local_listens_on_the_port_asked_for_when_it_is_free() {
    let dir = tempfile::tempdir().unwrap();
    // A port that was free a moment ago.
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let server = start_local(LocalOptions {
        db: dir.path().join("workspace.db"),
        web_dir: dir.path().to_path_buf(),
        preset: Preset::Blank,
        member_name: "Ada".to_string(),
        port: Some(port),
        read_only: false,
        moved_to: None,
    })
    .await
    .unwrap();
    assert_eq!(server.origin(), format!("http://127.0.0.1:{port}"));
    assert!(
        server
            .entry_url()
            .starts_with(&format!("http://127.0.0.1:{port}/api/local/enter?key="))
    );
    server.stop().await;
}

#[tokio::test]
async fn start_local_takes_another_port_when_the_one_asked_for_is_taken() {
    let dir = tempfile::tempdir().unwrap();
    let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = taken.local_addr().unwrap().port();
    let server = start_local(LocalOptions {
        db: dir.path().join("workspace.db"),
        web_dir: dir.path().to_path_buf(),
        preset: Preset::Blank,
        member_name: "Ada".to_string(),
        port: Some(port),
        read_only: false,
        moved_to: None,
    })
    .await
    .unwrap();
    let got = server
        .origin()
        .strip_prefix("http://127.0.0.1:")
        .unwrap()
        .parse::<u16>()
        .unwrap();
    assert_ne!(got, port);
    assert_ne!(got, 0);
    server.stop().await;
    drop(taken);
}
