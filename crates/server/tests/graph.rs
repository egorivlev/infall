//! M15b — the Branch Graph (contract §18) and `GET …/changes?before=`.

mod common;

use std::sync::Arc;
use std::time::Instant;

use axum::http::StatusCode;
use common::*;
use qoop_core::{EntityId, EntityKind, Fields, MemberId, Moment, Op, Value as V, Workspace};
use qoop_server::store::{MemoryStore, Store};
use serde_json::{Value, json};

async fn ops(app: &TestApp, cookie: &str, branch: &str, list: Value) {
    let res = app.ops(cookie, branch, list).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
}

async fn checkpoint(app: &TestApp, cookie: &str, branch: &str, name: &str, seq: u64) {
    let res = app
        .post(
            &format!("/api/branches/{branch}/checkpoints"),
            Some(cookie),
            json!({ "name": name, "seq": seq }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
}

async fn fork(app: &TestApp, cookie: &str, name: &str, branch: &str, seq: u64) -> String {
    let res = app
        .post(
            "/api/branches",
            Some(cookie),
            json!({ "name": name, "from": { "branch": branch, "seq": seq } }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    res.body["branch"]["id"].as_str().unwrap().to_string()
}

/// Plans and applies a Merge without Conflicts; returns how many Changes it made.
async fn merge(app: &TestApp, cookie: &str, source: &str, target: &str) -> usize {
    let plan = app
        .get(
            &format!("/api/merges/plan?source={source}&target={target}"),
            Some(cookie),
        )
        .await;
    assert_eq!(plan.status, StatusCode::OK, "{}", plan.text);
    let res = app
        .post(
            "/api/merges",
            Some(cookie),
            json!({ "plan": plan.body["plan"], "decisions": [] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    res.body["changes"].as_array().unwrap().len()
}

async fn graph(app: &TestApp, cookie: &str) -> Value {
    let res = app.get("/api/graph", Some(cookie)).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    res.body
}

fn branch<'g>(graph: &'g Value, name: &str) -> &'g Value {
    graph["branches"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["name"] == name)
        .unwrap_or_else(|| panic!("no Branch {name}"))
}

/// `[kind, author, from_seq, to_seq]` of every Activity of a Branch.
fn runs(b: &Value) -> Vec<(String, String, u64, u64)> {
    b["activities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| {
            (
                a["kind"].as_str().unwrap().to_string(),
                a["author"].as_str().unwrap().to_string(),
                a["from_seq"].as_u64().unwrap(),
                a["to_seq"].as_u64().unwrap(),
            )
        })
        .collect()
}

fn run(kind: &str, author: &str, from: u64, to: u64) -> (String, String, u64, u64) {
    (kind.to_string(), author.to_string(), from, to)
}

async fn id_of(app: &TestApp, cookie: &str) -> String {
    app.get("/api/me", Some(cookie)).await.body["member"]["id"]
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn the_graph_gives_every_branch_with_its_activities_checkpoints_forks_and_merges() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let ana = app.join(&admin, "ana@example.org", "member", None).await;
    let (me, ana_id) = (id_of(&app, &admin).await, id_of(&app, &ana).await);
    let main = app.main_branch(&admin).await;
    let (a, b, c) = (new_id(), new_id(), new_id());

    ops(
        &app,
        &admin,
        &main,
        json!([create_card(&a, "A"), create_card(&b, "B")]),
    )
    .await;
    app.clock.advance(60_000);
    ops(&app, &ana, &main, json!([create_card(&c, "C")])).await;
    checkpoint(&app, &admin, &main, "before-review", 3).await;
    app.clock.advance(60_000);
    let exp = fork(&app, &admin, "exp-A", &main, 3).await;
    checkpoint(&app, &admin, &exp, "exp-start", 0).await;

    // A clock that goes backwards inside one Activity.
    ops(&app, &admin, &exp, json!([set_title(&a, "A-exp")])).await;
    let first_at = START + 120_000;
    app.clock.advance(-5 * 60_000);
    ops(&app, &admin, &exp, json!([set_title(&b, "B-exp")])).await;
    app.clock.advance(10 * 60_000);

    assert_eq!(merge(&app, &admin, &exp, &main).await, 2); // into the parent
    ops(&app, &ana, &main, json!([set_title(&c, "C2")])).await;
    assert_eq!(merge(&app, &ana, &main, &exp).await, 1); // update from the parent
    assert_eq!(merge(&app, &admin, &exp, &main).await, 0); // changed nothing: no Activity
    let restore = app
        .post(
            &format!("/api/branches/{main}/restore"),
            Some(&admin),
            json!({ "to_seq": 3 }),
        )
        .await;
    assert_eq!(restore.status, StatusCode::OK, "{}", restore.text);
    let undone = restore.body["changes"].as_array().unwrap().len() as u64;
    assert!(undone > 0);
    ops(&app, &admin, &main, json!([set_title(&a, "A3")])).await;

    let g = graph(&app, &admin).await;
    let names: Vec<&str> = g["branches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["main", "exp-A"]);

    let m = branch(&g, "main");
    let head = 6 + undone + 1;
    assert_eq!(m["id"], main.as_str());
    assert_eq!(m["seq"], head);
    assert!(m.get("parent").is_none());
    assert!(m.get("created_by").is_none());
    assert_eq!(
        runs(m),
        [
            run("edit", &me, 0, 2),
            run("edit", &ana_id, 2, 3),
            run("merge", &me, 3, 5),
            run("edit", &ana_id, 5, 6),
            run("restore", &me, 6, 6 + undone),
            run("edit", &me, 6 + undone, head),
        ]
    );
    let acts = m["activities"].as_array().unwrap();
    assert_eq!(acts[0]["started_at"], START);
    assert_eq!(acts[0]["ended_at"], START);
    assert_eq!(acts[1]["started_at"], START + 60_000);
    assert_eq!(acts[2]["source"], json!({ "branch": exp, "seq": 2 }));
    assert!(acts[2].get("to").is_none());
    assert_eq!(acts[4]["to"], 3);
    assert!(acts[4].get("source").is_none());
    assert!(acts[0].get("source").is_none() && acts[0].get("to").is_none());
    assert_eq!(
        m["checkpoints"],
        json!([{ "name": "before-review", "seq": 3, "author": me, "at": START + 60_000 }])
    );

    let e = branch(&g, "exp-A");
    assert_eq!(e["seq"], 3);
    assert_eq!(e["parent"], json!({ "branch": main, "seq": 3 }));
    assert_eq!(e["created_by"], me.as_str());
    assert_eq!(e["created_at"], START + 120_000);
    assert_eq!(e["checkpoints"][0]["name"], "exp-start");
    assert_eq!(e["checkpoints"][0]["seq"], 0);
    assert_eq!(
        runs(e),
        [run("edit", &me, 0, 2), run("merge", &ana_id, 2, 3)]
    );
    let ea = e["activities"].as_array().unwrap();
    assert_eq!(ea[0]["started_at"], first_at);
    assert_eq!(ea[0]["ended_at"], first_at - 5 * 60_000);
    assert_eq!(ea[1]["source"], json!({ "branch": main, "seq": 6 }));
}

#[tokio::test]
async fn a_checkpoint_ends_the_activity_it_falls_in_and_gap_ms_is_the_longest_pause() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let me = id_of(&app, &admin).await;
    let main = app.main_branch(&admin).await;
    let (a, b) = (new_id(), new_id());
    ops(
        &app,
        &admin,
        &main,
        json!([create_card(&a, "A"), create_card(&b, "B")]),
    )
    .await;
    app.clock.advance(2_000);
    ops(&app, &admin, &main, json!([set_title(&a, "A2")])).await;

    let g = graph(&app, &admin).await;
    assert_eq!(runs(branch(&g, "main")), [run("edit", &me, 0, 3)]);
    let tight = app.get("/api/graph?gap_ms=1000", Some(&admin)).await;
    assert_eq!(tight.status, StatusCode::OK);
    assert_eq!(
        runs(branch(&tight.body, "main")),
        [run("edit", &me, 0, 2), run("edit", &me, 2, 3)]
    );

    checkpoint(&app, &admin, &main, "inside", 1).await;
    checkpoint(&app, &admin, &main, "at-start", 0).await;
    checkpoint(&app, &admin, &main, "at-head", 3).await;
    let g = graph(&app, &admin).await;
    assert_eq!(
        runs(branch(&g, "main")),
        [run("edit", &me, 0, 1), run("edit", &me, 1, 3)]
    );
    let seqs: Vec<u64> = branch(&g, "main")["checkpoints"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["seq"].as_u64().unwrap())
        .collect();
    assert_eq!(seqs, [0, 1, 3]);

    // A Change after a Checkpoint at the head starts a new Activity.
    ops(&app, &admin, &main, json!([set_title(&b, "B2")])).await;
    let g = graph(&app, &admin).await;
    assert_eq!(
        runs(branch(&g, "main")),
        [
            run("edit", &me, 0, 1),
            run("edit", &me, 1, 3),
            run("edit", &me, 3, 4)
        ]
    );

    for bad in ["gap_ms=-1", "gap_ms=soon", "gap_ms="] {
        let res = app.get(&format!("/api/graph?{bad}"), Some(&admin)).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{bad}");
    }
}

#[tokio::test]
async fn an_empty_workspace_has_main_with_nothing_on_it() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let main = app.main_branch(&admin).await;
    let g = graph(&app, &admin).await;
    assert_eq!(
        g,
        json!({ "branches": [{ "id": main, "name": "main", "seq": 0, "checkpoints": [], "activities": [] }] })
    );
}

#[tokio::test]
async fn guests_and_strangers_have_no_graph() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let guest = app
        .join(&admin, "g@example.org", "guest", Some(START + 1_000_000))
        .await;
    let res = app.get("/api/graph", Some(&guest)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.code(), "forbidden");
    let res = app.get("/api/graph", None).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_local_workspace_has_the_graph_too() {
    use qoop_server::Clock;
    use qoop_server::local::{Preset, build_local_app, local_config};

    let web = web_dir();
    let mut config = local_config(([127, 0, 0, 1], 4321).into(), web.path().to_path_buf());
    config.dev_origin = Some(ORIGIN.to_string());
    let store: Arc<dyn Store> = Arc::new(MemoryStore::new());
    let clock = Clock::manual(START);
    let built = build_local_app(
        config,
        store.clone(),
        clock.clone(),
        Preset::Tutorial,
        "Ada",
    )
    .unwrap();
    let app = TestApp {
        router: built.router,
        clock,
        store,
        web,
    };
    let enter = app
        .get(&format!("/api/local/enter?key={}", built.entry_key), None)
        .await;
    let cookie = enter.cookie();
    let g = graph(&app, &cookie).await;
    let m = branch(&g, "main");
    let seq = m["seq"].as_u64().unwrap();
    assert!(seq > 0, "the Tutorial Preset seeds main");
    let acts = m["activities"].as_array().unwrap();
    assert_eq!(acts.first().unwrap()["from_seq"], 0);
    assert_eq!(acts.last().unwrap()["to_seq"], seq);
}

#[tokio::test]
async fn changes_can_be_read_up_to_before() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let main = app.main_branch(&admin).await;
    let (a, b) = (new_id(), new_id());
    ops(
        &app,
        &admin,
        &main,
        json!([
            create_card(&a, "A"),
            create_card(&b, "B"),
            set_title(&a, "A2"),
            set_title(&b, "B2")
        ]),
    )
    .await;
    let all = app
        .get(
            &format!("/api/branches/{main}/changes?after=0"),
            Some(&admin),
        )
        .await
        .body;
    let path = |q: &str| format!("/api/branches/{main}/changes?{q}");

    let mid = app.get(&path("after=1&before=3"), Some(&admin)).await;
    assert_eq!(mid.status, StatusCode::OK, "{}", mid.text);
    assert_eq!(mid.body["seq"], 4);
    assert_eq!(
        mid.body["changes"],
        json!(all["changes"].as_array().unwrap()[1..3])
    );
    let to_head = app.get(&path("after=2&before=4"), Some(&admin)).await;
    assert_eq!(to_head.body["changes"].as_array().unwrap().len(), 2);
    let none = app.get(&path("after=2&before=2"), Some(&admin)).await;
    assert_eq!(none.body["changes"], json!([]));
    let from_start = app.get(&path("before=1"), Some(&admin)).await;
    assert_eq!(
        from_start.body["changes"],
        json!(all["changes"].as_array().unwrap()[..1])
    );
    let unchanged = app.get(&path("after=1"), Some(&admin)).await;
    assert_eq!(unchanged.body["changes"].as_array().unwrap().len(), 3);

    for bad in ["after=3&before=2", "before=5", "after=0&before=x"] {
        let res = app.get(&path(bad), Some(&admin)).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{bad}");
    }
    let guest = app
        .join(&admin, "g@example.org", "guest", Some(START + 1_000_000))
        .await;
    let res = app.get(&path("after=0&before=1"), Some(&guest)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
}

/// A Workspace with `n` Changes on main and a Branch forked halfway, built with the core so
/// that the test does not post them one request at a time.
fn big_workspace(n: u64) -> Workspace {
    let (mut ws, main) = Workspace::new();
    let people = [MemberId::new(), MemberId::new(), MemberId::new()];
    let card = EntityId::new();
    let mut fields = Fields::new();
    fields.insert("title".to_string(), V::Text("Big".to_string()));
    let create = Op::Create {
        entity: card,
        kind: EntityKind::Card,
        fields,
    };
    ws.record(main, people[0], START, create).unwrap();
    let set = |i: u64| Op::Set {
        entity: card,
        field: "title".to_string(),
        value: V::Text(format!("T{i}")),
    };
    let batch = 500;
    let mut at = START;
    let mut seq = 1;
    let mut forked = false;
    while seq < n {
        let author = people[(seq / batch % 3) as usize];
        let ops: Vec<Op> = (0..batch.min(n - seq)).map(|i| set(seq + i)).collect();
        seq += ops.len() as u64;
        at += 1_000;
        ws.record_all(main, author, at, ops).unwrap();
        if !forked && seq >= n / 2 {
            forked = true;
            let exp = ws
                .fork("exp", Moment { branch: main, seq }, people[1], at)
                .unwrap();
            ws.record_all(exp, people[1], at, (0..1_000).map(set).collect())
                .unwrap();
        }
    }
    // Thousands of Activities: a Checkpoint every 20 Changes.
    for (i, s) in (20..n).step_by(20).enumerate() {
        ws.checkpoint(
            &format!("cp{i}"),
            Moment {
                branch: main,
                seq: s,
            },
            people[2],
            at,
        )
        .unwrap();
    }
    ws
}

#[tokio::test]
async fn the_graph_of_tens_of_thousands_of_changes_answers_fast() {
    let n = 50_000;
    let store = Arc::new(MemoryStore::new());
    store.save_workspace(&big_workspace(n)).unwrap();
    let app = TestApp::with_store(store);
    let admin = app.admin().await;

    let start = Instant::now();
    let res = app.get("/api/graph", Some(&admin)).await;
    let took = start.elapsed();
    assert_eq!(res.status, StatusCode::OK);
    let m = branch(&res.body, "main");
    assert_eq!(m["seq"], n);
    let acts = m["activities"].as_array().unwrap();
    assert!(acts.len() >= 2_500, "{}", acts.len());
    assert_eq!(acts.last().unwrap()["to_seq"], n);
    assert_eq!(
        branch(&res.body, "exp")["activities"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    eprintln!(
        "GET /api/graph: {n} Changes, {} Activities, {} bytes, {took:?} (debug build)",
        acts.len(),
        res.text.len()
    );
    // Generous for an unoptimised build on a laptop; a release build is far faster.
    assert!(took.as_millis() < 3_000, "{took:?}");
}
