mod common;

use std::sync::Arc;

use axum::http::{StatusCode, header};
use common::*;
use qoop_server::store::{MemoryStore, SqliteStore, Store};
use serde_json::{Value, json};

struct World {
    app: TestApp,
    admin: String,
    main: String,
    token: String,
}

async fn world_on(store: Arc<dyn Store>) -> World {
    let app = TestApp::with_store(store);
    let admin = app.admin().await;
    let main = app.main_branch(&admin).await;
    let token = app.access_token(&admin, "tools").await;
    World {
        app,
        admin,
        main,
        token,
    }
}

async fn world() -> World {
    world_on(Arc::new(MemoryStore::new())).await
}

fn text(s: &str) -> Value {
    json!({ "Text": s })
}

fn float(f: f64) -> Value {
    json!({ "Float": f })
}

fn reference(id: &str) -> Value {
    json!({ "Ref": id })
}

/// The ids of a small Board.
struct Small {
    spin: String,
    replica: String,
    cavity: String,
    deleted: String,
}

/// Three live Cards and a deleted one; a Frame around `spin` and `replica`; a Page on
/// `spin`; two Sources; a Connection of each kind.
async fn small_board(w: &World) -> Small {
    let ids: Vec<String> = (0..16).map(|_| new_id()).collect();
    let (spin, replica, cavity, deleted) = (&ids[0], &ids[1], &ids[2], &ids[3]);
    let (frame, b1, b2, s1, s2, a1, a2, a3) = (
        &ids[4], &ids[5], &ids[6], &ids[7], &ids[8], &ids[9], &ids[10], &ids[11],
    );
    let ops = json!([
        create(
            frame,
            "Frame",
            json!({
                "title": text("Mean field"), "x": float(0.0), "y": float(0.0),
                "w": float(600.0), "h": float(300.0)
            })
        ),
        create(
            spin,
            "Card",
            json!({
                "title": text("Spin glasses"), "summary": text("Disordered magnets"),
                "status": text("reading"), "x": float(20.0), "y": float(20.0)
            })
        ),
        create(
            replica,
            "Card",
            json!({
                "title": text("Replica trick"), "x": float(300.0), "y": float(100.0),
                "w": float(224.0), "h": float(132.0)
            })
        ),
        create(
            cavity,
            "Card",
            json!({
                "title": text("Cavity method"), "summary": text("An alternative to replicas"),
                "x": float(900.0), "y": float(0.0)
            })
        ),
        create(
            deleted,
            "Card",
            json!({ "title": text("Deleted spin card") })
        ),
        create(
            b2,
            "Block",
            json!({
                "card": reference(spin), "type": text("text"), "order": text("b"),
                "text": text("The energy is $H = -\\sum J_{ij} s_i s_j$.")
            })
        ),
        create(
            b1,
            "Block",
            json!({
                "card": reference(spin), "type": text("text"), "order": text("a"),
                "text": text("# Overview")
            })
        ),
        create(
            s1,
            "Source",
            json!({
                "title": text("Solvable Model of a Spin-Glass"),
                "authors": text("Sherrington, D.; Kirkpatrick, S."),
                "year": text("1975"), "doi": text("10.1103/PhysRevLett.35.1792")
            })
        ),
        create(
            s2,
            "Source",
            json!({ "url": text("https://example.org/notes") })
        ),
        create(
            a1,
            "Attachment",
            json!({ "card": reference(spin), "source": reference(s1) })
        ),
        create(
            a2,
            "Attachment",
            json!({ "card": reference(replica), "source": reference(s1) })
        ),
        create(
            a3,
            "Attachment",
            json!({ "card": reference(deleted), "source": reference(s2) })
        ),
        create(
            &ids[12],
            "Connection",
            json!({
                "from": reference(spin), "to": reference(replica), "kind": text("directed"),
                "label": text("solved by")
            })
        ),
        create(
            &ids[13],
            "Connection",
            json!({
                "from": reference(cavity), "to": reference(replica), "kind": text("contradicts")
            })
        ),
        create(
            &ids[14],
            "Connection",
            json!({ "from": reference(cavity), "to": reference(spin) })
        ),
        create(
            &ids[15],
            "Connection",
            json!({ "from": reference(spin), "to": reference(deleted) })
        ),
        delete_op(deleted),
    ]);
    w.app.ops(&w.admin, &w.main, ops).await;
    Small {
        spin: spin.clone(),
        replica: replica.clone(),
        cavity: cavity.clone(),
        deleted: deleted.clone(),
    }
}

// ---------------------------------------------------------------- protocol

#[tokio::test]
async fn initialize_negotiates_the_protocol_version() {
    let w = world().await;
    for (asked, answered) in [
        (json!("2025-06-18"), "2025-06-18"),
        (json!("2025-03-26"), "2025-03-26"),
        (json!("2024-11-05"), "2024-11-05"),
        (json!("2030-01-01"), "2025-06-18"),
        (json!("1.0"), "2025-06-18"),
        (json!(null), "2025-06-18"),
    ] {
        let res = w
            .app
            .rpc(
                &w.token,
                "initialize",
                json!({
                    "protocolVersion": asked,
                    "capabilities": {},
                    "clientInfo": { "name": "test", "version": "0" }
                }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        assert_eq!(
            res.headers.get(header::CONTENT_TYPE).unwrap(),
            "application/json"
        );
        assert!(res.headers.get("mcp-session-id").is_none());
        assert_eq!(res.body["jsonrpc"], "2.0");
        assert_eq!(res.body["id"], 1);
        let result = &res.body["result"];
        assert_eq!(result["protocolVersion"], answered, "asked {asked}");
        assert_eq!(result["capabilities"], json!({ "tools": {} }));
        assert_eq!(
            result["serverInfo"],
            json!({ "name": "qoop", "version": env!("CARGO_PKG_VERSION") })
        );
        let instructions = result["instructions"].as_str().unwrap();
        assert!(instructions.contains("Infall"));
        assert!(instructions.contains("Suggestion"));
        assert!(instructions.contains("Member"));
    }
    // Without params at all.
    let res = w
        .app
        .mcp(
            Some(&w.token),
            json!({ "jsonrpc": "2.0", "id": "a", "method": "initialize" }),
        )
        .await;
    assert_eq!(res.body["id"], "a");
    assert_eq!(res.body["result"]["protocolVersion"], "2025-06-18");
}

#[tokio::test]
async fn ping_notifications_and_unknown_methods() {
    let w = world().await;
    let res = w.app.rpc(&w.token, "ping", json!({})).await;
    assert_eq!(res.body, json!({ "jsonrpc": "2.0", "id": 1, "result": {} }));

    // Notifications — the expected one and any other — are accepted with no body.
    for method in [
        "notifications/initialized",
        "notifications/cancelled",
        "whatever",
    ] {
        let res = w
            .app
            .mcp(
                Some(&w.token),
                json!({ "jsonrpc": "2.0", "method": method }),
            )
            .await;
        assert_eq!(res.status, StatusCode::ACCEPTED, "{method}");
        assert_eq!(res.text, "");
    }
    // A response to a request the server never made is accepted and ignored.
    let res = w
        .app
        .mcp(
            Some(&w.token),
            json!({ "jsonrpc": "2.0", "id": 9, "result": {} }),
        )
        .await;
    assert_eq!(res.status, StatusCode::ACCEPTED);
    assert_eq!(res.text, "");

    for method in [
        "resources/list",
        "prompts/list",
        "tools/unknown",
        "",
        "initialize2",
    ] {
        let res = w.app.rpc(&w.token, method, json!({})).await;
        assert_eq!(res.status, StatusCode::OK, "{method}");
        assert_eq!(res.body["id"], 1);
        assert_eq!(res.body["error"]["code"], -32601, "{method}");
        assert!(res.body.get("result").is_none());
    }
}

#[tokio::test]
async fn malformed_and_oversized_messages_are_refused_as_json_rpc_errors() {
    let w = world().await;
    let before = w.app.workspace_bytes();
    for raw in ["", "{", "not json", "{\"jsonrpc\":\"2.0\",", "\u{0}"] {
        let res = w.app.mcp_raw(Some(&w.token), raw.to_string()).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{raw:?}");
        assert_eq!(res.body["jsonrpc"], "2.0");
        assert_eq!(res.body["id"], Value::Null);
        assert_eq!(res.body["error"]["code"], -32700, "{raw:?}");
    }
    // Deeply nested JSON is a parse error, not a crash.
    let deep = format!("{}{}", "[".repeat(100_000), "]".repeat(100_000));
    let res = w.app.mcp_raw(Some(&w.token), deep).await;
    assert_eq!(res.body["error"]["code"], -32700);

    for bad in [
        json!(5),
        json!("ping"),
        json!(null),
        json!([]),
        // No batches: one message per request.
        json!([{ "jsonrpc": "2.0", "id": 1, "method": "ping" }]),
        json!({}),
        json!({ "id": 1, "method": "ping" }),
        json!({ "jsonrpc": "1.0", "id": 1, "method": "ping" }),
        json!({ "jsonrpc": "2.0", "id": 1 }),
        json!({ "jsonrpc": "2.0", "id": 1, "method": 7 }),
        json!({ "jsonrpc": "2.0", "id": null, "method": "ping" }),
        json!({ "jsonrpc": "2.0", "id": {}, "method": "ping" }),
        json!({ "jsonrpc": "2.0", "id": [1], "method": "tools/list" }),
    ] {
        let res = w.app.mcp(Some(&w.token), bad.clone()).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{bad}");
        assert_eq!(res.body["error"]["code"], -32600, "{bad}");
        assert!(res.body.get("result").is_none());
    }

    // Just over 1 MB, though perfectly valid.
    let big = json!({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": { "name": "list_cards", "arguments": { "query": "x".repeat(1024 * 1024) } }
    });
    let res = w.app.mcp(Some(&w.token), big).await;
    assert_eq!(res.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(res.body["error"]["code"], -32600);
    assert!(res.text.len() < 500);
    // Just under is read.
    let fits = json!({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": { "name": "list_cards", "arguments": { "query": "x".repeat(1024 * 1024 - 200) } }
    });
    let res = w.app.mcp(Some(&w.token), fits).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body["result"]["isError"], false);
    assert_eq!(w.app.workspace_bytes(), before);
}

#[tokio::test]
async fn tools_list_gives_the_eight_tools_with_schemas_and_annotations() {
    let w = world().await;
    let res = w.app.rpc(&w.token, "tools/list", json!({})).await;
    assert_eq!(res.status, StatusCode::OK);
    let tools = res.body["result"]["tools"].as_array().unwrap();
    let expected: [(&str, &[&str], &[&str], bool); 8] = [
        ("list_branches", &[], &[], true),
        ("list_cards", &["branch", "query", "frame"], &[], true),
        ("get_card", &["branch", "card"], &["card"], true),
        ("list_connections", &["branch"], &[], true),
        ("list_sources", &["branch"], &[], true),
        ("list_suggestions", &["branch"], &[], true),
        (
            "suggest_source",
            &[
                "branch", "card", "url", "doi", "title", "authors", "year", "reason", "model",
            ],
            &["card", "reason"],
            false,
        ),
        (
            "suggest_connection",
            &["branch", "from", "to", "kind", "label", "reason", "model"],
            &["from", "to", "reason"],
            false,
        ),
    ];
    assert_eq!(tools.len(), expected.len());
    for (tool, (name, properties, required, read_only)) in tools.iter().zip(expected) {
        assert_eq!(tool["name"], name);
        let description = tool["description"].as_str().unwrap();
        assert!(description.len() > 100, "{name}: a description for a model");
        let schema = &tool["inputSchema"];
        assert_eq!(schema["type"], "object", "{name}");
        let mut got: Vec<&str> = schema["properties"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        got.sort();
        let mut want = properties.to_vec();
        want.sort();
        assert_eq!(got, want, "{name}");
        for (arg, spec) in schema["properties"].as_object().unwrap() {
            assert_eq!(spec["type"], "string", "{name}.{arg}");
            assert!(spec["description"].is_string(), "{name}.{arg}");
        }
        assert_eq!(schema["required"], json!(required), "{name}");
        assert_eq!(tool["annotations"]["readOnlyHint"], read_only, "{name}");
        if !read_only {
            assert!(description.contains("nothing changes until a Member accepts it"));
            assert!(description.contains("concrete `reason`"));
            assert_eq!(tool["annotations"]["destructiveHint"], false);
        }
    }
    assert_eq!(
        tools[7]["inputSchema"]["properties"]["kind"]["enum"],
        json!(["related", "directed", "contradicts"])
    );
}

#[tokio::test]
async fn a_bad_tool_call_is_a_protocol_error_but_bad_arguments_are_a_tool_error() {
    let w = world().await;
    let s = small_board(&w).await;

    // No such tool, or no tool name: JSON-RPC errors.
    for params in [
        json!({ "name": "delete_everything", "arguments": {} }),
        json!({ "name": "list_cards2" }),
        json!({ "arguments": {} }),
        json!({ "name": 5 }),
        json!([]),
        json!("list_cards"),
    ] {
        let res = w.app.rpc(&w.token, "tools/call", params.clone()).await;
        assert_eq!(res.status, StatusCode::OK, "{params}");
        assert_eq!(res.body["error"]["code"], -32602, "{params}");
        assert!(res.body.get("result").is_none());
    }
    let res = w
        .app
        .mcp(
            Some(&w.token),
            json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call" }),
        )
        .await;
    assert_eq!(res.body["error"]["code"], -32602);

    // Arguments of the wrong type: a result with `isError` and a sentence.
    let cases: Vec<(&str, Value, &str)> = vec![
        (
            "list_cards",
            json!([]),
            "`arguments` must be a JSON object.",
        ),
        (
            "list_cards",
            json!("main"),
            "`arguments` must be a JSON object.",
        ),
        ("list_cards", json!(3), "`arguments` must be a JSON object."),
        (
            "list_cards",
            json!({ "branch": 3 }),
            "`branch` must be a string.",
        ),
        (
            "list_cards",
            json!({ "query": ["a"] }),
            "`query` must be a string.",
        ),
        (
            "list_cards",
            json!({ "frame": true }),
            "`frame` must be a string.",
        ),
        (
            "list_connections",
            json!({ "branch": {} }),
            "`branch` must be a string.",
        ),
        ("get_card", json!({}), "`card` is required."),
        ("get_card", json!({ "card": null }), "`card` is required."),
        (
            "get_card",
            json!({ "card": 12 }),
            "`card` must be a string.",
        ),
        (
            "get_card",
            json!({ "card": { "id": s.spin } }),
            "`card` must be a string.",
        ),
        (
            "suggest_source",
            json!({ "card": s.spin, "doi": 10.1, "reason": "r" }),
            "`doi` must be a string.",
        ),
        (
            "suggest_source",
            json!({ "card": s.spin, "doi": "10.1/x", "year": 1975, "reason": "r" }),
            "`year` must be a string.",
        ),
        (
            "suggest_source",
            json!({ "card": s.spin, "doi": "10.1/x" }),
            "`reason` is required.",
        ),
        (
            "suggest_connection",
            json!({ "from": s.spin, "reason": "r" }),
            "`to` is required.",
        ),
        (
            "suggest_connection",
            json!({ "from": s.spin, "to": s.replica, "reason": ["r"] }),
            "`reason` must be a string.",
        ),
    ];
    for (tool, arguments, sentence) in cases {
        let got = w.app.tool_err(&w.token, tool, arguments.clone()).await;
        assert_eq!(got, sentence, "{tool} {arguments}");
    }

    // An unknown Branch, on every tool that takes one.
    for tool in [
        "list_cards",
        "get_card",
        "list_connections",
        "list_sources",
        "list_suggestions",
        "suggest_source",
        "suggest_connection",
    ] {
        let got = w
            .app
            .tool_err(
                &w.token,
                tool,
                json!({ "branch": "nowhere", "card": s.spin, "from": s.spin, "to": s.replica,
                        "doi": "10.1/x", "reason": "r" }),
            )
            .await;
        assert_eq!(
            got,
            "There is no Branch named \"nowhere\". Use list_branches to see the Branches."
        );
    }
    // A Branch id is not a Branch name.
    let got = w
        .app
        .tool_err(&w.token, "list_cards", json!({ "branch": w.main }))
        .await;
    assert!(got.starts_with("There is no Branch named"), "{got}");

    // Absent and null arguments are the same as none; unknown ones are ignored.
    for arguments in [
        Value::Null,
        json!({}),
        json!({ "branch": null, "extra": 1 }),
    ] {
        let listed = w.app.tool_ok(&w.token, "list_cards", arguments).await;
        assert_eq!(listed["cards"].as_array().unwrap().len(), 3);
    }
    let res = w
        .app
        .rpc(&w.token, "tools/call", json!({ "name": "list_cards" }))
        .await;
    assert_eq!(res.body["result"]["isError"], false);
}

// ---------------------------------------------------------------- the read tools

#[tokio::test]
async fn the_read_tools_describe_a_small_board() {
    for store in [
        Arc::new(MemoryStore::new()) as Arc<dyn Store>,
        Arc::new(SqliteStore::open_in_memory().unwrap()),
    ] {
        let w = world_on(store).await;
        let s = small_board(&w).await;
        // A second Branch, forked before the Board was filled, with one Card of its own.
        let res = w
            .app
            .post(
                "/api/branches",
                Some(&w.admin),
                json!({ "name": "alt", "from": { "branch": w.main, "seq": 0 } }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        let alt = res.body["branch"]["id"].as_str().unwrap().to_string();
        let only = new_id();
        w.app
            .ops(&w.admin, &alt, json!([create_card(&only, "Only on alt")]))
            .await;

        assert_eq!(
            w.app.tool_ok(&w.token, "list_branches", json!({})).await,
            json!([
                { "name": "main", "changes": 17 },
                { "name": "alt", "parent": "main", "changes": 1 }
            ])
        );

        // list_cards: by title; the deleted Card is not there.
        let cards = w.app.tool_ok(&w.token, "list_cards", json!({})).await;
        assert_eq!(
            cards,
            json!({
                "cards": [
                    { "id": s.cavity, "title": "Cavity method", "status": "idea",
                      "summary": "An alternative to replicas", "blocks": 0, "sources": 0 },
                    { "id": s.replica, "title": "Replica trick", "status": "idea",
                      "summary": "", "frame": "Mean field", "blocks": 0, "sources": 1 },
                    { "id": s.spin, "title": "Spin glasses", "status": "reading",
                      "summary": "Disordered magnets", "frame": "Mean field",
                      "blocks": 2, "sources": 1 },
                ],
                "truncated": false
            })
        );
        assert!(!cards.to_string().contains(&s.deleted));
        let ids = |v: &Value| -> Vec<String> {
            v["cards"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| c["id"].as_str().unwrap().to_string())
                .collect()
        };
        let found = w
            .app
            .tool_ok(&w.token, "list_cards", json!({ "query": "REPLICA" }))
            .await;
        assert_eq!(ids(&found), [s.cavity.clone(), s.replica.clone()]);
        let found = w
            .app
            .tool_ok(&w.token, "list_cards", json!({ "query": "spin" }))
            .await;
        assert_eq!(
            ids(&found),
            std::slice::from_ref(&s.spin),
            "the deleted match is not listed"
        );
        let framed = w
            .app
            .tool_ok(&w.token, "list_cards", json!({ "frame": "mean field" }))
            .await;
        assert_eq!(ids(&framed), [s.replica.clone(), s.spin.clone()]);
        let both = w
            .app
            .tool_ok(
                &w.token,
                "list_cards",
                json!({ "frame": "Mean field", "query": "trick" }),
            )
            .await;
        assert_eq!(ids(&both), std::slice::from_ref(&s.replica));
        let err = w
            .app
            .tool_err(&w.token, "list_cards", json!({ "frame": "Nope" }))
            .await;
        assert_eq!(err, "There is no Frame titled \"Nope\" on this Branch.");
        let on_alt = w
            .app
            .tool_ok(&w.token, "list_cards", json!({ "branch": "alt" }))
            .await;
        assert_eq!(ids(&on_alt), std::slice::from_ref(&only));

        // get_card.
        let card = w
            .app
            .tool_ok(&w.token, "get_card", json!({ "card": s.spin }))
            .await;
        assert_eq!(card["id"], s.spin);
        assert_eq!(card["title"], "Spin glasses");
        assert_eq!(card["status"], "reading");
        assert_eq!(card["summary"], "Disordered magnets");
        assert_eq!(card["frame"], "Mean field");
        assert_eq!(
            card["page"],
            "# Overview\n\nThe energy is $H = -\\sum J_{ij} s_i s_j$."
        );
        assert_eq!(
            card["sources"],
            json!([{
                "title": "Solvable Model of a Spin-Glass",
                "authors": "Sherrington, D.; Kirkpatrick, S.",
                "year": "1975",
                "doi": "10.1103/PhysRevLett.35.1792"
            }])
        );
        let mut connections = card["connections"].as_array().unwrap().clone();
        connections.sort_by_key(|c| c["other"]["title"].as_str().unwrap().to_string());
        assert_eq!(
            connections,
            vec![
                json!({ "other": { "id": s.cavity, "title": "Cavity method" },
                        "direction": "none", "kind": "related" }),
                json!({ "other": { "id": s.replica, "title": "Replica trick" },
                        "direction": "out", "kind": "directed", "label": "solved by" }),
            ]
        );
        let replica = w
            .app
            .tool_ok(&w.token, "get_card", json!({ "card": s.replica }))
            .await;
        let mut seen: Vec<(String, String, String)> = replica["connections"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                (
                    c["other"]["title"].as_str().unwrap().to_string(),
                    c["direction"].as_str().unwrap().to_string(),
                    c["kind"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        seen.sort();
        assert_eq!(
            seen,
            [
                ("Cavity method".into(), "none".into(), "contradicts".into()),
                ("Spin glasses".into(), "in".into(), "directed".into()),
            ]
        );
        assert_eq!(replica["page"], "");
        let cavity = w
            .app
            .tool_ok(&w.token, "get_card", json!({ "card": s.cavity }))
            .await;
        assert!(cavity.get("frame").is_none());
        assert_eq!(cavity["sources"], json!([]));
        // The deleted Card, a Card of another Branch and nonsense are all "no Card".
        for (branch, id) in [
            ("main", s.deleted.clone()),
            ("main", only.clone()),
            ("alt", s.spin.clone()),
            ("main", "nonsense".to_string()),
        ] {
            let err = w
                .app
                .tool_err(
                    &w.token,
                    "get_card",
                    json!({ "branch": branch, "card": id }),
                )
                .await;
            assert!(err.starts_with("There is no Card with id"), "{err}");
        }

        // list_connections: the three visible ones.
        let listed = w.app.tool_ok(&w.token, "list_connections", json!({})).await;
        assert_eq!(listed["truncated"], false);
        let mut kinds: Vec<(String, String, String, Value)> = listed["connections"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                (
                    c["kind"].as_str().unwrap().to_string(),
                    c["from"]["id"].as_str().unwrap().to_string(),
                    c["to"]["title"].as_str().unwrap().to_string(),
                    c.get("label").cloned().unwrap_or(Value::Null),
                )
            })
            .collect();
        kinds.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            kinds,
            [
                (
                    "contradicts".into(),
                    s.cavity.clone(),
                    "Replica trick".into(),
                    Value::Null
                ),
                (
                    "directed".into(),
                    s.spin.clone(),
                    "Replica trick".into(),
                    json!("solved by")
                ),
                (
                    "related".into(),
                    s.cavity.clone(),
                    "Spin glasses".into(),
                    Value::Null
                ),
            ]
        );
        assert!(!listed.to_string().contains(&s.deleted));

        // list_sources: both live Sources; the one attached only to the deleted Card has
        // no Cards.
        let listed = w.app.tool_ok(&w.token, "list_sources", json!({})).await;
        assert_eq!(listed["truncated"], false);
        let mut sources = listed["sources"].as_array().unwrap().clone();
        sources.sort_by_key(|s| s.get("title").is_none());
        // Cards come in id order.
        let mut attached = vec![
            json!({ "id": s.replica, "title": "Replica trick" }),
            json!({ "id": s.spin, "title": "Spin glasses" }),
        ];
        attached.sort_by_key(|c| c["id"].as_str().unwrap().to_string());
        assert_eq!(
            sources[0],
            json!({
                "title": "Solvable Model of a Spin-Glass",
                "authors": "Sherrington, D.; Kirkpatrick, S.",
                "year": "1975",
                "doi": "10.1103/PhysRevLett.35.1792",
                "cards": attached
            })
        );
        assert_eq!(
            sources[1],
            json!({ "url": "https://example.org/notes", "cards": [] })
        );
        assert_eq!(sources.len(), 2);
        assert_eq!(
            w.app
                .tool_ok(&w.token, "list_sources", json!({ "branch": "alt" }))
                .await,
            json!({ "sources": [], "truncated": false })
        );
        assert_eq!(
            w.app.tool_ok(&w.token, "list_suggestions", json!({})).await,
            json!([])
        );
    }
}

#[tokio::test]
async fn long_lists_and_pages_are_cut_and_flagged() {
    let w = world().await;
    // 201 Cards, one with a Page over the limit.
    let ids: Vec<String> = (0..201).map(|_| new_id()).collect();
    let ops: Vec<Value> = ids
        .iter()
        .enumerate()
        .map(|(i, id)| create_card(id, &format!("Card {i:03}")))
        .collect();
    for chunk in ops.chunks(200) {
        w.app.ops(&w.admin, &w.main, json!(chunk)).await;
    }
    let listed = w.app.tool_ok(&w.token, "list_cards", json!({})).await;
    assert_eq!(listed["cards"].as_array().unwrap().len(), 200);
    assert_eq!(listed["truncated"], true);
    assert_eq!(listed["cards"][199]["title"], "Card 199");
    let narrowed = w
        .app
        .tool_ok(&w.token, "list_cards", json!({ "query": "card 20" }))
        .await;
    assert_eq!(narrowed["cards"].as_array().unwrap().len(), 1);
    assert_eq!(narrowed["truncated"], false);

    let blocks: Vec<Value> = ["a", "b", "c"]
        .iter()
        .map(|order| {
            create(
                &new_id(),
                "Block",
                json!({
                    "card": { "Ref": ids[0] }, "type": text("text"), "order": text(order),
                    "text": text(&order.repeat(9_000))
                }),
            )
        })
        .collect();
    w.app.ops(&w.admin, &w.main, json!(blocks)).await;
    let card = w
        .app
        .tool_ok(&w.token, "get_card", json!({ "card": ids[0] }))
        .await;
    let page = card["page"].as_str().unwrap();
    assert_eq!(page.chars().count(), 20_001);
    assert!(page.starts_with("aaaa"));
    assert!(page.ends_with("c…"));
    assert_eq!(listed["cards"][0]["blocks"], 0);
    let listed = w
        .app
        .tool_ok(&w.token, "list_cards", json!({ "query": "Card 000" }))
        .await;
    assert_eq!(listed["cards"][0]["blocks"], 3);

    // 501 Connections and 501 Sources.
    let mut ops = Vec::new();
    for _ in 0..501 {
        ops.push(create(
            &new_id(),
            "Connection",
            json!({ "from": { "Ref": ids[0] }, "to": { "Ref": ids[1] } }),
        ));
        ops.push(create(
            &new_id(),
            "Source",
            json!({ "doi": text(&format!("10.1/{}", new_id())) }),
        ));
    }
    for chunk in ops.chunks(200) {
        w.app.ops(&w.admin, &w.main, json!(chunk)).await;
    }
    let connections = w.app.tool_ok(&w.token, "list_connections", json!({})).await;
    assert_eq!(connections["connections"].as_array().unwrap().len(), 500);
    assert_eq!(connections["truncated"], true);
    let sources = w.app.tool_ok(&w.token, "list_sources", json!({})).await;
    assert_eq!(sources["sources"].as_array().unwrap().len(), 500);
    assert_eq!(sources["truncated"], true);
}

// ---------------------------------------------------------------- suggest_*

async fn suggestions(w: &World, branch: &str) -> Vec<Value> {
    let res = w
        .app
        .get(&format!("/api/suggestions?branch={branch}"), Some(&w.admin))
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    res.body["suggestions"].as_array().unwrap().clone()
}

#[tokio::test]
async fn suggest_source_makes_a_pending_suggestion_by_the_tokens_member() {
    for store in [
        Arc::new(MemoryStore::new()) as Arc<dyn Store>,
        Arc::new(SqliteStore::open_in_memory().unwrap()),
    ] {
        let w = world_on(store).await;
        let s = small_board(&w).await;
        let bea = w
            .app
            .join(&w.admin, "bea@example.org", "member", None)
            .await;
        let bea_id = w.app.get("/api/me", Some(&bea)).await.body["member"]["id"].clone();
        let beas = w.app.access_token(&bea, "bea's").await;
        w.app.clock.advance(1_000);

        let made = w
            .app
            .tool_ok(
                &beas,
                "suggest_source",
                json!({
                    "card": s.cavity,
                    "url": " https://example.org/mezard-parisi ",
                    "doi": "10.1007/PL00011099",
                    "title": "The Bethe lattice spin glass revisited",
                    "authors": "Mézard, M.; Parisi, G.",
                    "year": "2001",
                    "reason": "  The paper that formulates the cavity method at 1RSB.  ",
                    "model": "claude-test"
                }),
            )
            .await;
        let id = made["id"].as_str().unwrap().to_string();
        assert_eq!(
            made,
            json!({ "id": id, "state": "pending", "note": "A Member will review this Suggestion." })
        );
        assert_eq!(
            suggestions(&w, &w.main).await,
            vec![json!({
                "id": id,
                "branch": w.main,
                "kind": "source",
                "card": s.cavity,
                "source": {
                    "url": "https://example.org/mezard-parisi",
                    "doi": "10.1007/PL00011099",
                    "title": "The Bethe lattice spin glass revisited",
                    "authors": "Mézard, M.; Parisi, G.",
                    "year": "2001"
                },
                "reason": "The paper that formulates the cavity method at 1RSB.",
                "created_by": bea_id,
                "model": "claude-test",
                "created_at": START + 1_000,
                "state": "pending"
            })]
        );
        assert_eq!(
            w.app.tool_ok(&w.token, "list_suggestions", json!({})).await,
            json!([{
                "id": id,
                "kind": "source",
                "summary": "Attach the Source \"The Bethe lattice spin glass revisited\", doi:10.1007/PL00011099, https://example.org/mezard-parisi to Card \"Cavity method\"",
                "reason": "The paper that formulates the cavity method at 1RSB."
            }])
        );

        // The same doi for the same Card — from anyone, with other details — is the same
        // Suggestion; so is the same url.
        w.app.clock.advance(1_000);
        for arguments in [
            json!({ "card": s.cavity, "doi": "10.1007/pl00011099", "reason": "Again." }),
            json!({ "card": s.cavity, "url": "https://example.org/mezard-parisi",
                    "title": "Other title", "reason": "Once more." }),
        ] {
            let again = w.app.tool_ok(&w.token, "suggest_source", arguments).await;
            assert_eq!(again["id"], id);
            assert_eq!(again["state"], "pending");
        }
        assert_eq!(suggestions(&w, &w.main).await.len(), 1);
        // Another Card, or another doi, is another Suggestion; minimal arguments suffice.
        let other = w
            .app
            .tool_ok(
                &w.token,
                "suggest_source",
                json!({ "card": s.spin, "doi": "10.1007/PL00011099", "reason": "Also here." }),
            )
            .await;
        assert_ne!(other["id"], id);
        let list = suggestions(&w, &w.main).await;
        assert_eq!(list.len(), 2);
        // Newest first; absent optional fields are left out.
        assert_eq!(list[0]["id"], other["id"]);
        assert_eq!(list[0]["source"], json!({ "doi": "10.1007/PL00011099" }));
        assert!(list[0].get("model").is_none());
        assert!(list[0].get("decided_by").is_none());
        // Once it is decided, the same proposal makes a new Suggestion.
        let res = w
            .app
            .post(
                &format!("/api/suggestions/{id}/reject"),
                Some(&w.admin),
                json!({}),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        let fresh = w
            .app
            .tool_ok(
                &w.token,
                "suggest_source",
                json!({ "card": s.cavity, "doi": "10.1007/PL00011099", "reason": "Reconsider." }),
            )
            .await;
        assert_ne!(fresh["id"], id);
    }
}

#[tokio::test]
async fn suggest_connection_makes_a_pending_suggestion_and_spots_the_reverse() {
    let w = world().await;
    let s = small_board(&w).await;
    let made = w
        .app
        .tool_ok(
            &w.token,
            "suggest_connection",
            json!({ "from": s.cavity, "to": s.spin, "reason": "Both treat the SK model." }),
        )
        .await;
    let id = made["id"].as_str().unwrap().to_string();
    assert_eq!(made["state"], "pending");
    assert_eq!(made["note"], "A Member will review this Suggestion.");
    let list = suggestions(&w, &w.main).await;
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["kind"], "connection");
    assert!(list[0].get("card").is_none());
    assert!(list[0].get("source").is_none());
    assert_eq!(
        list[0]["connection"],
        json!({ "from": s.cavity, "to": s.spin, "kind": "related" })
    );

    // The same pair in either direction, whatever the kind, is the same Suggestion.
    let again = w
        .app
        .tool_ok(
            &w.token,
            "suggest_connection",
            json!({ "from": s.spin, "to": s.cavity, "kind": "directed", "label": "x",
                    "reason": "Reversed." }),
        )
        .await;
    assert_eq!(again["id"], id);
    w.app.clock.advance(1_000);
    let other = w
        .app
        .tool_ok(
            &w.token,
            "suggest_connection",
            json!({ "from": s.spin, "to": s.replica, "kind": "contradicts",
                    "label": "tension", "reason": "They disagree.", "model": "m" }),
        )
        .await;
    assert_ne!(other["id"], id);
    let list = suggestions(&w, &w.main).await;
    assert_eq!(
        list[0]["connection"],
        json!({ "from": s.spin, "to": s.replica, "kind": "contradicts", "label": "tension" })
    );
    let listed = w.app.tool_ok(&w.token, "list_suggestions", json!({})).await;
    assert_eq!(
        listed[0]["summary"],
        "Connect Card \"Spin glasses\" to Card \"Replica trick\" as contradicts, labelled \"tension\""
    );
    assert_eq!(listed[1]["id"], id);
}

#[tokio::test]
async fn suggestions_are_checked_against_the_branch_they_are_for() {
    let w = world().await;
    let s = small_board(&w).await;
    let head = w.app.get("/api/branches", Some(&w.admin)).await.body["branches"][0]["seq"].clone();
    let res = w
        .app
        .post(
            "/api/branches",
            Some(&w.admin),
            json!({ "name": "alt", "from": { "branch": w.main, "seq": head } }),
        )
        .await;
    let alt = res.body["branch"]["id"].as_str().unwrap().to_string();
    // On `alt` the cavity Card is deleted; on `main` it lives.
    w.app
        .ops(&w.admin, &alt, json!([delete_op(&s.cavity)]))
        .await;

    let on_alt = json!({ "branch": "alt", "card": s.cavity, "doi": "10.1/x", "reason": "r" });
    let err = w.app.tool_err(&w.token, "suggest_source", on_alt).await;
    assert!(err.starts_with("There is no Card with id"), "{err}");
    let err = w
        .app
        .tool_err(
            &w.token,
            "suggest_connection",
            json!({ "branch": "alt", "from": s.spin, "to": s.cavity, "reason": "r" }),
        )
        .await;
    assert!(err.starts_with("There is no Card with id"), "{err}");

    let made = w
        .app
        .tool_ok(
            &w.token,
            "suggest_source",
            json!({ "branch": "alt", "card": s.spin, "doi": "10.1/x", "reason": "r" }),
        )
        .await;
    assert_eq!(suggestions(&w, &alt).await[0]["id"], made["id"]);
    assert_eq!(suggestions(&w, &alt).await[0]["branch"], alt);
    assert!(suggestions(&w, &w.main).await.is_empty());
    // The same proposal on another Branch is not a duplicate.
    let on_main = w
        .app
        .tool_ok(
            &w.token,
            "suggest_source",
            json!({ "card": s.spin, "doi": "10.1/x", "reason": "r" }),
        )
        .await;
    assert_ne!(on_main["id"], made["id"]);
    assert_eq!(
        w.app
            .tool_ok(&w.token, "list_suggestions", json!({ "branch": "alt" }))
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn every_creation_rule_is_enforced_through_the_tools() {
    let w = world().await;
    let s = small_board(&w).await;
    let long = "x".repeat(501);
    let source = |change: Value| {
        let mut args = json!({ "card": s.spin, "doi": "10.1/x", "reason": "A reason." });
        for (k, v) in change.as_object().unwrap() {
            args[k] = v.clone();
        }
        args
    };
    let cases: Vec<(Value, &str)> = vec![
        (
            source(json!({ "card": s.deleted })),
            "There is no Card with id",
        ),
        (
            source(json!({ "card": new_id() })),
            "There is no Card with id",
        ),
        (source(json!({ "card": "x" })), "There is no Card with id"),
        (
            source(json!({ "doi": null })),
            "A Source needs a `url` or a `doi`.",
        ),
        (
            source(json!({ "doi": "", "url": " " })),
            "A Source needs a `url` or a `doi`.",
        ),
        (
            source(json!({ "url": "ftp://example.org" })),
            "`url` must be an http:// or https:// address.",
        ),
        (
            source(json!({ "url": "javascript:alert(1)" })),
            "`url` must be an http:// or https:// address.",
        ),
        (
            source(json!({ "url": "example.org/paper" })),
            "`url` must be an http:// or https:// address.",
        ),
        (
            source(json!({ "url": "https://a b.org" })),
            "`url` must be an http:// or https:// address.",
        ),
        (
            source(json!({ "url": format!("https://example.org/{}", "x".repeat(2000)) })),
            "`url` may be at most 2000 characters.",
        ),
        (
            source(json!({ "doi": long })),
            "`doi` may be at most 500 characters.",
        ),
        (
            source(json!({ "title": long })),
            "`title` may be at most 500 characters.",
        ),
        (
            source(json!({ "authors": long })),
            "`authors` may be at most 500 characters.",
        ),
        (
            source(json!({ "year": long })),
            "`year` may be at most 500 characters.",
        ),
        (
            source(json!({ "reason": long })),
            "`reason` may be at most 500 characters.",
        ),
        (source(json!({ "reason": "  " })), "`reason` is required"),
        (
            source(json!({ "reason": "line\nbreak" })),
            "`reason` must be one line",
        ),
        (
            source(json!({ "title": "tab\there" })),
            "`title` must be one line",
        ),
        (
            source(json!({ "model": "m".repeat(81) })),
            "`model` may be at most 80 characters.",
        ),
    ];
    for (arguments, sentence) in cases {
        let got = w
            .app
            .tool_err(&w.token, "suggest_source", arguments.clone())
            .await;
        assert!(got.starts_with(sentence), "{arguments}: {got}");
    }
    let connection = |change: Value| {
        let mut args = json!({ "from": s.spin, "to": s.cavity, "reason": "A reason." });
        for (k, v) in change.as_object().unwrap() {
            args[k] = v.clone();
        }
        args
    };
    let cases: Vec<(Value, &str)> = vec![
        (
            connection(json!({ "to": s.spin })),
            "`from` and `to` must be two different Cards.",
        ),
        (
            connection(json!({ "to": s.deleted })),
            "There is no Card with id",
        ),
        (
            connection(json!({ "from": new_id() })),
            "There is no Card with id",
        ),
        (
            connection(json!({ "kind": "causes" })),
            "`kind` must be one of related, directed or contradicts",
        ),
        (
            connection(json!({ "kind": "Directed" })),
            "`kind` must be one of",
        ),
        (
            connection(json!({ "label": long })),
            "`label` may be at most 500 characters.",
        ),
        (
            connection(json!({ "label": "a\u{0}b" })),
            "`label` must be one line",
        ),
        (connection(json!({ "reason": "" })), "`reason` is required"),
        (
            connection(json!({ "model": "m".repeat(81) })),
            "`model` may be at most 80",
        ),
    ];
    for (arguments, sentence) in cases {
        let got = w
            .app
            .tool_err(&w.token, "suggest_connection", arguments.clone())
            .await;
        assert!(got.starts_with(sentence), "{arguments}: {got}");
    }
    assert!(
        suggestions(&w, &w.main).await.is_empty(),
        "nothing was stored"
    );
}

#[tokio::test]
async fn a_branch_holds_at_most_100_pending_suggestions() {
    let w = world().await;
    let s = small_board(&w).await;
    let mut first = String::new();
    for i in 0..100 {
        let made = w
            .app
            .tool_ok(
                &w.token,
                "suggest_source",
                json!({ "card": s.spin, "doi": format!("10.1/{i}"), "reason": "r" }),
            )
            .await;
        if i == 0 {
            first = made["id"].as_str().unwrap().to_string();
        }
        // Keep clear of the rate limit: this test is about the other one.
        w.app.clock.advance(1_000);
    }
    let full = "This Branch already has 100 pending Suggestions. A Member has to review some before more can be added.";
    let err = w
        .app
        .tool_err(
            &w.token,
            "suggest_source",
            json!({ "card": s.spin, "doi": "10.1/one-too-many", "reason": "r" }),
        )
        .await;
    assert_eq!(err, full);
    let err = w
        .app
        .tool_err(
            &w.token,
            "suggest_connection",
            json!({ "from": s.spin, "to": s.cavity, "reason": "r" }),
        )
        .await;
    assert_eq!(err, full);
    assert_eq!(suggestions(&w, &w.main).await.len(), 100);
    // A duplicate of a pending one is still answered with that one.
    let again = w
        .app
        .tool_ok(
            &w.token,
            "suggest_source",
            json!({ "card": s.spin, "doi": "10.1/0", "reason": "r" }),
        )
        .await;
    assert_eq!(again["id"], first.as_str());
    // Deciding one makes room.
    let res = w
        .app
        .post(
            &format!("/api/suggestions/{first}/reject"),
            Some(&w.admin),
            json!({}),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    w.app
        .tool_ok(
            &w.token,
            "suggest_connection",
            json!({ "from": s.spin, "to": s.cavity, "reason": "r" }),
        )
        .await;
    // ...and then the rejected one cannot be reopened into a 101st? It can: reopening is
    // a Member's undo, not an AI's proposal.
    let res = w
        .app
        .post(
            &format!("/api/suggestions/{first}/reopen"),
            Some(&w.admin),
            json!({}),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
}

// ---------------------------------------------------------------- tools never change the Workspace

#[tokio::test]
async fn no_tool_call_changes_the_workspace() {
    for store in [
        Arc::new(MemoryStore::new()) as Arc<dyn Store>,
        Arc::new(SqliteStore::open_in_memory().unwrap()),
    ] {
        let w = world_on(store).await;
        let s = small_board(&w).await;
        let board_path = format!("/api/branches/{}/board", w.main);
        let changes_path = format!("/api/branches/{}/changes", w.main);
        let stored = w.app.workspace_bytes();
        let board = w.app.get(&board_path, Some(&w.admin)).await.text;
        let changes = w.app.get(&changes_path, Some(&w.admin)).await.text;
        let branches = w.app.get("/api/branches", Some(&w.admin)).await.text;

        let calls: Vec<(&str, Value)> = vec![
            ("list_branches", json!({})),
            ("list_cards", json!({})),
            (
                "list_cards",
                json!({ "query": "spin", "frame": "Mean field" }),
            ),
            ("list_cards", json!({ "frame": "none such" })),
            ("get_card", json!({ "card": s.spin })),
            ("get_card", json!({ "card": s.deleted })),
            ("list_connections", json!({})),
            ("list_sources", json!({})),
            ("list_suggestions", json!({})),
            (
                "suggest_source",
                json!({ "card": s.spin, "url": "https://example.org/a", "title": "A",
                        "reason": "Because." }),
            ),
            // A duplicate, and ones that fail.
            (
                "suggest_source",
                json!({ "card": s.spin, "url": "https://example.org/a", "reason": "Again." }),
            ),
            (
                "suggest_source",
                json!({ "card": s.deleted, "doi": "10.1/x", "reason": "r" }),
            ),
            ("suggest_source", json!({ "card": s.spin, "reason": "r" })),
            (
                "suggest_connection",
                json!({ "from": s.spin, "to": s.cavity, "kind": "directed", "label": "l",
                        "reason": "Because." }),
            ),
            (
                "suggest_connection",
                json!({ "from": s.spin, "to": s.spin, "reason": "r" }),
            ),
            ("suggest_connection", json!({ "from": 1, "to": 2 })),
            ("list_suggestions", json!({})),
            ("list_cards", json!({ "branch": "nowhere" })),
        ];
        for (tool, arguments) in calls {
            w.app.tool(&w.token, tool, arguments.clone()).await;
            assert_eq!(
                w.app.workspace_bytes(),
                stored,
                "{tool} {arguments} changed the stored Workspace"
            );
            assert_eq!(
                w.app.get(&board_path, Some(&w.admin)).await.text,
                board,
                "{tool} {arguments} changed the Board"
            );
        }
        // Every protocol method too.
        for method in ["initialize", "ping", "tools/list", "resources/list"] {
            w.app.rpc(&w.token, method, json!({})).await;
        }
        assert_eq!(w.app.workspace_bytes(), stored);
        assert_eq!(w.app.get(&changes_path, Some(&w.admin)).await.text, changes);
        assert_eq!(
            w.app.get("/api/branches", Some(&w.admin)).await.text,
            branches
        );
        // The two that succeeded did make Suggestions — and only those.
        assert_eq!(suggestions(&w, &w.main).await.len(), 2);
    }
}

// ---------------------------------------------------------------- faults stay inside

#[tokio::test]
async fn a_server_fault_in_a_tool_is_one_plain_sentence() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("qoop.db");
    let w = world_on(Arc::new(SqliteStore::open(&path).unwrap())).await;
    let s = small_board(&w).await;
    // Break the store under the running server.
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch("DROP TABLE suggestions")
        .unwrap();

    for (tool, arguments) in [
        ("list_suggestions", json!({})),
        (
            "suggest_source",
            json!({ "card": s.spin, "doi": "10.1/x", "reason": "r" }),
        ),
        (
            "suggest_connection",
            json!({ "from": s.spin, "to": s.cavity, "reason": "r" }),
        ),
    ] {
        let res = w
            .app
            .rpc(
                &w.token,
                "tools/call",
                json!({ "name": tool, "arguments": arguments }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{tool}");
        assert_eq!(res.body["result"]["isError"], true, "{tool}");
        assert_eq!(
            res.body["result"]["content"][0]["text"],
            "Something went wrong on the server. Try again later.",
            "{tool}"
        );
        let lower = res.text.to_lowercase();
        for inside in [
            "sql", "table", "no such", "storage", "rusqlite", "panic", ".rs",
        ] {
            assert!(
                !lower.contains(inside),
                "{tool} leaked {inside:?}: {}",
                res.text
            );
        }
    }
    // The tools that do not need that table still work, and the HTTP API fails closed.
    w.app.tool_ok(&w.token, "list_cards", json!({})).await;
    let res = w
        .app
        .get(
            &format!("/api/suggestions?branch={}", w.main),
            Some(&w.admin),
        )
        .await;
    assert_eq!(res.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        res.body["error"]["message"],
        "Something went wrong on the server."
    );
    assert!(!res.text.to_lowercase().contains("table"));
}
