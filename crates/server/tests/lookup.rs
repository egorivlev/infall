//! M13 — Sources that fill themselves in (docs/specs/portability.md, Contract B; api.md
//! §17): `POST /api/sources/lookup` against a stand-in for Crossref and arXiv. No test here
//! reaches the network: every base address points at a local fake.

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use common::{ORIGIN, START, TestApp, web_dir};
use infall_server::Clock;
use infall_server::config::Config;
use infall_server::local::{Preset, build_local_app, local_config};
use infall_server::sources::LOOKUPS_PER_MINUTE;
use infall_server::store::{MemoryStore, Store};
use serde_json::{Value, json};

/// What the fake does with the next request.
#[derive(Clone)]
enum Answer {
    Status(u16, &'static str, String),
    Hang,
}

#[derive(Clone)]
struct Seen {
    path: String,
    query: String,
    headers: HeaderMap,
}

#[derive(Default)]
struct Fake {
    answer: Mutex<Option<Answer>>,
    seen: Mutex<Vec<Seen>>,
}

struct Registry {
    url: String,
    fake: Arc<Fake>,
}

impl Registry {
    fn answer(&self, a: Answer) {
        *self.fake.answer.lock().unwrap() = Some(a);
    }
    fn json(&self, status: u16, body: Value) {
        self.answer(Answer::Status(status, "application/json", body.to_string()));
    }
    fn text(&self, status: u16, content_type: &'static str, body: &str) {
        self.answer(Answer::Status(status, content_type, body.to_string()));
    }
    fn seen(&self) -> Vec<Seen> {
        self.fake.seen.lock().unwrap().clone()
    }
}

async fn serve(State(fake): State<Arc<Fake>>, req: Request) -> Response {
    fake.seen.lock().unwrap().push(Seen {
        path: req.uri().path().to_string(),
        query: req.uri().query().unwrap_or("").to_string(),
        headers: req.headers().clone(),
    });
    let answer = fake.answer.lock().unwrap().clone();
    match answer {
        None => (StatusCode::INTERNAL_SERVER_ERROR, "no answer scripted").into_response(),
        Some(Answer::Hang) => {
            tokio::time::sleep(Duration::from_secs(3600)).await;
            StatusCode::OK.into_response()
        }
        Some(Answer::Status(status, content_type, body)) => Response::builder()
            .status(status)
            .header("content-type", content_type)
            .body(axum::body::Body::from(body))
            .unwrap(),
    }
}

async fn registry() -> Registry {
    let fake = Arc::new(Fake::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = Router::new().fallback(serve).with_state(fake.clone());
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Registry {
        url: format!("http://{addr}"),
        fake,
    }
}

struct World {
    app: TestApp,
    crossref: Registry,
    arxiv: Registry,
}

fn point(config: &mut Config, crossref: &Registry, arxiv: &Registry) {
    config.crossref_url = crossref.url.clone();
    config.arxiv_url = arxiv.url.clone();
    config.lookup_timeout = Duration::from_millis(500);
}

async fn team() -> World {
    let (crossref, arxiv) = (registry().await, registry().await);
    let app = TestApp::with_config(Arc::new(MemoryStore::new()), |c| {
        point(c, &crossref, &arxiv)
    });
    World {
        app,
        crossref,
        arxiv,
    }
}

async fn lookup(app: &TestApp, cookie: &str, body: Value) -> common::Res {
    app.post("/api/sources/lookup", Some(cookie), body).await
}

const CROSSREF_WORK: &str = r#"{
  "status": "ok",
  "message-type": "work",
  "message": {
    "DOI": "10.1103/PhysRevLett.35.1792",
    "title": ["Solvable Model of a <i>Spin-Glass</i> &amp; more"],
    "author": [
      { "given": "David", "family": "Sherrington", "sequence": "first" },
      { "given": "Scott", "family": "Kirkpatrick", "sequence": "additional" }
    ],
    "issued": { "date-parts": [[1975, 12, 29]] },
    "URL": "http://dx.doi.org/10.1103/physrevlett.35.1792"
  }
}"#;

const ARXIV_FEED: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title type="html">ArXiv Query: search_query=&amp;id_list=2103.05577</title>
  <entry>
    <id>http://arxiv.org/abs/2103.05577v2</id>
    <updated>2021-06-01T00:00:00Z</updated>
    <published>2021-03-09T17:02:11Z</published>
    <title>Ising   machines
  for &lt;hard&gt; problems</title>
    <summary>An abstract.</summary>
    <author><name>Naeimeh Mohseni</name></author>
    <author><name>Peter L. McMahon</name></author>
    <author><name>Tim Byrnes</name></author>
  </entry>
</feed>"#;

#[tokio::test]
async fn a_doi_is_looked_up_at_crossref() {
    let w = team().await;
    let cookie = w.app.admin().await;
    w.crossref.text(200, "application/json", CROSSREF_WORK);
    let res = lookup(
        &w.app,
        &cookie,
        json!({ "doi": "https://doi.org/10.1103/PhysRevLett.35.1792" }),
    )
    .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(
        res.body,
        json!({
            "title": "Solvable Model of a Spin-Glass & more",
            "authors": "David Sherrington, Scott Kirkpatrick",
            "year": "1975",
            "doi": "10.1103/PhysRevLett.35.1792",
            "url": null
        })
    );
    let seen = w.crossref.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].path, "/works/10.1103/PhysRevLett.35.1792");
    // Nothing about the person or the Workspace goes out.
    let h = &seen[0].headers;
    assert!(h.get("cookie").is_none());
    assert!(h.get("authorization").is_none());
    assert!(h.get("origin").is_none());
    assert!(h.get("referer").is_none());
    let agent = h["user-agent"].to_str().unwrap();
    assert!(agent.starts_with("infall-server/"), "{agent}");
    for (_, v) in h.iter() {
        let v = v.to_str().unwrap_or("");
        assert!(!v.contains("Ada") && !v.contains("example.org"), "{v}");
    }
    assert!(w.arxiv.seen().is_empty());
}

#[tokio::test]
async fn a_doi_with_odd_characters_is_sent_encoded() {
    let w = team().await;
    let cookie = w.app.admin().await;
    w.crossref
        .json(200, json!({ "message": { "title": ["Odd"] } }));
    let doi = "10.1002/(SICI)1097-0258(19980815/30)17:15/16<1661::AID-SIM968>3.0.CO;2-2";
    let res = lookup(&w.app, &cookie, json!({ "doi": doi })).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body["title"], "Odd");
    assert_eq!(res.body["authors"], "");
    assert_eq!(res.body["year"], "");
    assert_eq!(res.body["doi"], doi);
    let path = &w.crossref.seen()[0].path;
    assert_eq!(
        path,
        "/works/10.1002/%28SICI%291097-0258%2819980815/30%2917%3A15/16%3C1661%3A%3AAID-SIM968%3E3.0.CO%3B2-2"
    );
}

#[tokio::test]
async fn an_arxiv_id_is_looked_up_at_arxiv() {
    let w = team().await;
    let cookie = w.app.admin().await;
    w.arxiv.text(200, "application/atom+xml", ARXIV_FEED);
    let res = lookup(
        &w.app,
        &cookie,
        json!({ "arxiv": "https://arxiv.org/abs/2103.05577v2" }),
    )
    .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(
        res.body,
        json!({
            "title": "Ising machines for <hard> problems",
            "authors": "Naeimeh Mohseni, Peter L. McMahon, Tim Byrnes",
            "year": "2021",
            "doi": null,
            "url": "https://arxiv.org/abs/2103.05577v2"
        })
    );
    let seen = w.arxiv.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].path, "/api/query");
    assert_eq!(seen[0].query, "id_list=2103.05577v2&max_results=1");
    assert!(seen[0].headers.get("cookie").is_none());
    assert!(w.crossref.seen().is_empty());
}

#[tokio::test]
async fn what_the_registry_does_not_know_is_404() {
    let w = team().await;
    let cookie = w.app.admin().await;
    w.crossref.text(404, "text/plain", "Resource not found.");
    let res = lookup(&w.app, &cookie, json!({ "doi": "10.5555/nothing" })).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.code(), "not_found");
    assert!(
        res.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Crossref")
    );

    for feed in [
        r#"<feed xmlns="http://www.w3.org/2005/Atom"><title>q</title></feed>"#,
        r#"<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/api/errors#incorrect_id_format_for_2101.99999</id><title>Error</title></entry></feed>"#,
    ] {
        w.arxiv.text(200, "application/atom+xml", feed);
        let res = lookup(&w.app, &cookie, json!({ "arxiv": "2101.99999" })).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "{}", res.text);
        assert!(
            res.body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("arXiv")
        );
    }
}

#[tokio::test]
async fn a_registry_that_fails_is_502_with_a_sentence_and_never_its_own_text() {
    let w = team().await;
    let cookie = w.app.admin().await;
    let upstream_text = "UPSTREAM-SAYS-SOMETHING-PRIVATE";
    let doi = json!({ "doi": "10.1038/nature12373" });
    let arxiv = json!({ "arxiv": "2103.05577" });
    let cases: Vec<(&Registry, Value, Answer)> = vec![
        (
            &w.crossref,
            doi.clone(),
            Answer::Status(500, "text/plain", upstream_text.into()),
        ),
        (
            &w.crossref,
            doi.clone(),
            Answer::Status(503, "text/html", upstream_text.into()),
        ),
        (
            &w.crossref,
            doi.clone(),
            Answer::Status(429, "text/plain", upstream_text.into()),
        ),
        (
            &w.crossref,
            doi.clone(),
            Answer::Status(200, "application/json", upstream_text.into()),
        ),
        (
            &w.crossref,
            doi.clone(),
            Answer::Status(200, "application/json", r#"{"message":"x"}"#.into()),
        ),
        (&w.crossref, doi.clone(), Answer::Hang),
        (
            &w.arxiv,
            arxiv.clone(),
            Answer::Status(500, "text/plain", upstream_text.into()),
        ),
        (
            &w.arxiv,
            arxiv.clone(),
            Answer::Status(200, "text/html", format!("<html>{upstream_text}</html>")),
        ),
        (&w.arxiv, arxiv.clone(), Answer::Hang),
    ];
    for (registry, body, answer) in cases {
        registry.answer(answer);
        let res = lookup(&w.app, &cookie, body).await;
        assert_eq!(res.status, StatusCode::BAD_GATEWAY, "{}", res.text);
        assert_eq!(res.code(), "lookup_failed");
        let message = res.body["error"]["message"].as_str().unwrap();
        assert!(message.ends_with('.'), "{message}");
        assert!(message.contains("by hand"), "{message}");
        assert!(!res.text.contains(upstream_text));
    }
}

#[tokio::test]
async fn a_registry_that_cannot_be_reached_is_502() {
    // A port that nothing listens on.
    let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let dead = format!("http://{}", free.local_addr().unwrap());
    drop(free);
    let app = TestApp::with_config(Arc::new(MemoryStore::new()), |c| {
        c.crossref_url = dead.clone();
        c.arxiv_url = dead.clone();
    });
    let cookie = app.admin().await;
    for body in [
        json!({ "doi": "10.1038/nature12373" }),
        json!({ "arxiv": "2103.05577" }),
    ] {
        let res = lookup(&app, &cookie, body).await;
        assert_eq!(res.status, StatusCode::BAD_GATEWAY, "{}", res.text);
        assert!(
            res.body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("could not be reached")
        );
    }
}

#[tokio::test]
async fn bad_input_is_400_and_never_reaches_a_registry() {
    let w = team().await;
    let cookie = w.app.admin().await;
    for body in [
        json!({}),
        json!({ "doi": "10.1038/x", "arxiv": "2103.05577" }),
        json!({ "doi": "not a doi" }),
        json!({ "doi": 10.1038 }),
        json!({ "arxiv": "2103" }),
        json!({ "arxiv": "https://example.org/abs/2103.05577" }),
        json!({ "url": "https://example.org" }),
        json!([]),
        Value::Null,
    ] {
        let res = lookup(&w.app, &cookie, body.clone()).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{body}: {}", res.text);
        assert_eq!(res.code(), "bad_request");
    }
    assert!(w.crossref.seen().is_empty());
    assert!(w.arxiv.seen().is_empty());
}

#[tokio::test]
async fn guests_and_strangers_cannot_look_up() {
    let w = team().await;
    let admin = w.app.admin().await;
    let guest = w
        .app
        .join(&admin, "g@example.org", "guest", Some(START + 1_000_000))
        .await;
    let body = json!({ "doi": "10.1038/nature12373" });
    let res = lookup(&w.app, &guest, body.clone()).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.code(), "forbidden");
    let res = w.app.post("/api/sources/lookup", None, body).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    assert!(w.crossref.seen().is_empty());
}

#[tokio::test]
async fn each_member_has_30_lookups_a_minute() {
    let w = team().await;
    let admin = w.app.admin().await;
    let member = w.app.join(&admin, "bea@example.org", "member", None).await;
    w.crossref.text(200, "application/json", CROSSREF_WORK);
    let body = json!({ "doi": "10.1103/PhysRevLett.35.1792" });
    for i in 0..LOOKUPS_PER_MINUTE {
        let res = lookup(&w.app, &admin, body.clone()).await;
        assert_eq!(res.status, StatusCode::OK, "lookup {i}: {}", res.text);
    }
    let res = lookup(&w.app, &admin, body.clone()).await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(res.code(), "too_many_requests");
    assert_eq!(w.crossref.seen().len(), LOOKUPS_PER_MINUTE);
    // Bad input is not counted, and is still a 400.
    let res = lookup(&w.app, &admin, json!({ "doi": "nope" })).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    // Another Member has their own.
    let res = lookup(&w.app, &member, body.clone()).await;
    assert_eq!(res.status, StatusCode::OK);
    // A minute later there is room again.
    w.app.clock.advance(60_000);
    let res = lookup(&w.app, &admin, body).await;
    assert_eq!(res.status, StatusCode::OK);
}

#[tokio::test]
async fn a_local_workspace_looks_up_too() {
    let (crossref, arxiv) = (registry().await, registry().await);
    let web = web_dir();
    let mut config = local_config(([127, 0, 0, 1], 4321).into(), web.path().to_path_buf());
    config.dev_origin = Some(ORIGIN.to_string());
    point(&mut config, &crossref, &arxiv);
    let store: Arc<dyn Store> = Arc::new(MemoryStore::new());
    let clock = Clock::manual(START);
    let built =
        build_local_app(config, store.clone(), clock.clone(), Preset::Blank, "Ada").unwrap();
    let app = TestApp {
        router: built.router,
        clock,
        store,
        web,
    };
    let res = app
        .get(&format!("/api/local/enter?key={}", built.entry_key), None)
        .await;
    let cookie = res.cookie();
    arxiv.text(200, "application/atom+xml", ARXIV_FEED);
    let res = lookup(&app, &cookie, json!({ "arxiv": "arXiv:2103.05577" })).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(
        res.body["authors"],
        "Naeimeh Mohseni, Peter L. McMahon, Tim Byrnes"
    );
    assert_eq!(res.body["url"], "https://arxiv.org/abs/2103.05577");
}

#[test]
fn the_real_registries_are_the_defaults() {
    let c = Config::for_tests(".");
    assert_eq!(c.crossref_url, "https://api.crossref.org");
    assert_eq!(c.arxiv_url, "https://export.arxiv.org");
    assert_eq!(c.lookup_timeout, Duration::from_secs(10));
    let l = local_config(([127, 0, 0, 1], 1).into(), ".".into());
    assert_eq!(l.crossref_url, "https://api.crossref.org");
    assert_eq!(l.arxiv_url, "https://export.arxiv.org");
}
