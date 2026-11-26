mod common;

use std::sync::Arc;

use axum::http::StatusCode;
use common::*;
use infall_server::store::{MemoryStore, SCHEMA_VERSION, SqliteStore, Store};
use serde_json::{Value, json};

const WEEK: i64 = 7 * 24 * 60 * 60 * 1000;

/// An Admin (whose token the AI uses), a Member, a Guest and two Cards on `main`.
struct World {
    app: TestApp,
    admin: String,
    bea: String,
    guest: String,
    admin_id: String,
    bea_id: String,
    main: String,
    token: String,
    a: String,
    b: String,
}

async fn member_id(app: &TestApp, cookie: &str) -> String {
    app.get("/api/me", Some(cookie)).await.body["member"]["id"]
        .as_str()
        .unwrap()
        .to_string()
}

async fn world_on(store: Arc<dyn Store>) -> World {
    let app = TestApp::with_store(store);
    let admin = app.admin().await;
    let bea = app.join(&admin, "bea@example.org", "member", None).await;
    let guest = app
        .join(&admin, "gus@example.org", "guest", Some(START + 100 * WEEK))
        .await;
    let main = app.main_branch(&admin).await;
    let token = app.access_token(&admin, "tools").await;
    let (a, b) = (new_id(), new_id());
    app.ops(
        &admin,
        &main,
        json!([create_card(&a, "Card A"), create_card(&b, "Card B")]),
    )
    .await;
    World {
        admin_id: member_id(&app, &admin).await,
        bea_id: member_id(&app, &bea).await,
        app,
        admin,
        bea,
        guest,
        main,
        token,
        a,
        b,
    }
}

async fn world() -> World {
    world_on(Arc::new(MemoryStore::new())).await
}

fn stores() -> Vec<Arc<dyn Store>> {
    vec![
        Arc::new(MemoryStore::new()),
        Arc::new(SqliteStore::open_in_memory().unwrap()),
    ]
}

impl World {
    async fn suggest_source(&self, doi: &str) -> String {
        let made = self
            .app
            .tool_ok(
                &self.token,
                "suggest_source",
                json!({ "card": self.a, "doi": doi, "title": "A paper", "reason": "Relevant." }),
            )
            .await;
        made["id"].as_str().unwrap().to_string()
    }

    async fn suggest_connection(&self) -> String {
        let made = self
            .app
            .tool_ok(
                &self.token,
                "suggest_connection",
                json!({ "from": self.a, "to": self.b, "kind": "directed", "reason": "A leads to B." }),
            )
            .await;
        made["id"].as_str().unwrap().to_string()
    }

    async fn list(&self) -> Vec<Value> {
        let res = self
            .app
            .get(
                &format!("/api/suggestions?branch={}", self.main),
                Some(&self.admin),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        res.body["suggestions"].as_array().unwrap().clone()
    }

    async fn state_of(&self, id: &str) -> String {
        self.list()
            .await
            .iter()
            .find(|s| s["id"] == id)
            .expect("listed")["state"]
            .as_str()
            .unwrap()
            .to_string()
    }

    async fn act(&self, cookie: &str, id: &str, action: &str, body: Value) -> Res {
        self.app
            .post(
                &format!("/api/suggestions/{id}/{action}"),
                Some(cookie),
                body,
            )
            .await
    }

    async fn board(&self) -> Value {
        self.app
            .get(
                &format!("/api/branches/{}/board", self.main),
                Some(&self.admin),
            )
            .await
            .body
    }

    /// The ops the UI builds for a Source Suggestion: a new Source and its Attachment.
    fn source_ops(&self, source: &str, attachment: &str, doi: &str) -> Value {
        json!([
            create(
                source,
                "Source",
                json!({ "doi": { "Text": doi }, "title": { "Text": "A paper" } })
            ),
            create(
                attachment,
                "Attachment",
                json!({ "card": { "Ref": self.a }, "source": { "Ref": source } })
            ),
        ])
    }

    fn connection_ops(&self, id: &str) -> Value {
        json!([create(
            id,
            "Connection",
            json!({
                "from": { "Ref": self.a }, "to": { "Ref": self.b }, "kind": { "Text": "directed" }
            })
        )])
    }
}

// ---------------------------------------------------------------- accept

#[tokio::test]
async fn accepting_a_source_applies_the_ops_as_the_accepting_member() {
    for store in stores() {
        let w = world_on(store).await;
        let id = w.suggest_source("10.1/x").await;
        w.app.clock.advance(60_000);
        let (source, attachment) = (new_id(), new_id());

        let res = w
            .act(
                &w.bea,
                &id,
                "accept",
                json!({ "ops": w.source_ops(&source, &attachment, "10.1/x") }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        // Two Cards were there (seq 2); the Source and the Attachment make 4.
        assert_eq!(res.body["seq"], 4);
        let changes = res.body["changes"].as_array().unwrap();
        assert_eq!(changes.len(), 2);
        for change in changes {
            assert_eq!(
                change["author"], w.bea_id,
                "authored by who accepted, not by the AI's Member"
            );
            assert_eq!(change["at"], START + 60_000);
            assert_eq!(change["origin"], "Edit");
        }
        assert_eq!(changes[0]["op"]["Create"]["entity"], source);
        assert_eq!(changes[1]["op"]["Create"]["kind"], "Attachment");
        let accepted = &res.body["suggestion"];
        assert_eq!(accepted["id"], id);
        assert_eq!(accepted["state"], "accepted");
        assert_eq!(accepted["decided_by"], w.bea_id);
        assert_eq!(accepted["decided_at"], START + 60_000);
        assert_eq!(accepted["created_by"], w.admin_id);
        assert_eq!(accepted["created_at"], START);

        // It is on the Board, in the Changes, and listed as accepted.
        let board = w.board().await;
        assert_eq!(board["seq"], 4);
        assert_eq!(board["entities"][&source]["kind"], "Source");
        assert_eq!(
            board["entities"][&attachment]["fields"]["card"],
            json!({ "Ref": w.a })
        );
        let since = w
            .app
            .get(
                &format!("/api/branches/{}/changes?after=2", w.main),
                Some(&w.admin),
            )
            .await;
        assert_eq!(since.body["changes"], res.body["changes"]);
        assert_eq!(w.list().await, vec![accepted.clone()]);
        // The AI sees the Source now, and no pending Suggestion.
        let card = w
            .app
            .tool_ok(&w.token, "get_card", json!({ "card": w.a }))
            .await;
        assert_eq!(
            card["sources"],
            json!([{ "title": "A paper", "doi": "10.1/x" }])
        );
        assert_eq!(
            w.app.tool_ok(&w.token, "list_suggestions", json!({})).await,
            json!([])
        );

        // Accepting twice: already decided, and nothing more is applied.
        let stored = w.app.workspace_bytes();
        let again = w
            .act(
                &w.admin,
                &id,
                "accept",
                json!({ "ops": w.source_ops(&new_id(), &new_id(), "10.1/x") }),
            )
            .await;
        assert_eq!(again.status, StatusCode::CONFLICT);
        assert_eq!(again.code(), "already_decided");
        assert_eq!(w.app.workspace_bytes(), stored);
        assert_eq!(w.board().await["seq"], 4);
        assert_eq!(w.list().await[0]["decided_by"], w.bea_id);
        for action in ["reject", "reopen"] {
            let res = w.act(&w.admin, &id, action, json!({})).await;
            assert_eq!(res.code(), "already_decided", "{action}");
        }
        assert_eq!(w.state_of(&id).await, "accepted");
    }
}

#[tokio::test]
async fn accepting_a_connection_creates_it() {
    for store in stores() {
        let w = world_on(store).await;
        let id = w.suggest_connection().await;
        let connection = new_id();
        let res = w
            .act(
                &w.admin,
                &id,
                "accept",
                json!({ "ops": w.connection_ops(&connection) }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        assert_eq!(res.body["seq"], 3);
        assert_eq!(res.body["changes"].as_array().unwrap().len(), 1);
        assert_eq!(res.body["changes"][0]["author"], w.admin_id);
        assert_eq!(res.body["suggestion"]["state"], "accepted");
        assert_eq!(res.body["suggestion"]["decided_by"], w.admin_id);
        assert_eq!(
            w.app.tool_ok(&w.token, "list_connections", json!({})).await["connections"],
            json!([{
                "from": { "id": w.a, "title": "Card A" },
                "to": { "id": w.b, "title": "Card B" },
                "kind": "directed"
            }])
        );
    }
}

#[tokio::test]
async fn an_accept_the_core_refuses_is_409_rejected_and_leaves_it_pending() {
    for store in stores() {
        let w = world_on(store).await;
        let id = w.suggest_source("10.1/x").await;
        let stored = w.app.workspace_bytes();
        let source = new_id();
        let refused: Vec<Value> = vec![
            // An Attachment to a Source that does not exist.
            json!([create(
                &new_id(),
                "Attachment",
                json!({
                    "card": { "Ref": w.a }, "source": { "Ref": new_id() }
                })
            )]),
            // The first op is fine, the second is not: all or nothing.
            json!([
                create(&source, "Source", json!({ "doi": { "Text": "10.1/x" } })),
                create(
                    &new_id(),
                    "Attachment",
                    json!({ "card": { "Ref": new_id() }, "source": { "Ref": source } })
                ),
            ]),
            // An entity that already exists.
            json!([create_card(&w.a, "Again")]),
            // A value of the wrong type.
            json!([create(
                &new_id(),
                "Source",
                json!({ "doi": { "Float": 1.0 } })
            )]),
        ];
        for ops in refused {
            let res = w.act(&w.bea, &id, "accept", json!({ "ops": ops })).await;
            assert_eq!(res.status, StatusCode::CONFLICT, "{}", res.text);
            assert_eq!(res.code(), "rejected");
            assert!(
                !res.body["error"]["detail"].is_null(),
                "the core error is the detail"
            );
            assert_eq!(w.app.workspace_bytes(), stored);
            assert_eq!(w.state_of(&id).await, "pending");
        }
        assert_eq!(w.board().await["seq"], 2);
        assert!(w.board().await["entities"].get(&source).is_none());
        let listed = w.list().await;
        assert!(listed[0].get("decided_by").is_none());
        // It can still be accepted properly.
        let res = w
            .act(
                &w.bea,
                &id,
                "accept",
                json!({ "ops": w.source_ops(&source, &new_id(), "10.1/x") }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    }
}

#[tokio::test]
async fn accepting_after_the_card_was_deleted_is_409_stale_and_leaves_it_pending() {
    for store in stores() {
        let w = world_on(store).await;
        let for_source = w.suggest_source("10.1/x").await;
        let for_connection = w.suggest_connection().await;
        // A Suggestion that does not involve Card A at all is not affected.
        let spare = new_id();
        w.app
            .ops(&w.admin, &w.main, json!([create_card(&spare, "Card C")]))
            .await;
        let untouched = w
            .app
            .tool_ok(
                &w.token,
                "suggest_connection",
                json!({ "from": w.b, "to": spare, "reason": "Unrelated to A." }),
            )
            .await["id"]
            .as_str()
            .unwrap()
            .to_string();

        // Card A — the Source's Card and one end of the Connection — is deleted.
        w.app.ops(&w.admin, &w.main, json!([delete_op(&w.a)])).await;
        let stored = w.app.workspace_bytes();
        let seq = w.board().await["seq"].clone();

        let res = w
            .act(
                &w.bea,
                &for_source,
                "accept",
                json!({ "ops": w.source_ops(&new_id(), &new_id(), "10.1/x") }),
            )
            .await;
        assert_eq!(res.status, StatusCode::CONFLICT, "{}", res.text);
        assert_eq!(res.code(), "stale");
        assert_eq!(
            res.body["error"]["message"],
            "The Card this Suggestion was for is no longer on this Branch."
        );
        let res = w
            .act(
                &w.bea,
                &for_connection,
                "accept",
                json!({ "ops": w.connection_ops(&new_id()) }),
            )
            .await;
        assert_eq!(res.status, StatusCode::CONFLICT, "{}", res.text);
        assert_eq!(res.code(), "stale");
        // Whatever the ops are: even ones the core would take.
        let res = w
            .act(
                &w.bea,
                &for_source,
                "accept",
                json!({ "ops": [create_card(&new_id(), "Else")] }),
            )
            .await;
        assert_eq!(res.code(), "stale");

        assert_eq!(w.app.workspace_bytes(), stored, "nothing was applied");
        assert_eq!(w.board().await["seq"], seq);
        for id in [&for_source, &for_connection] {
            assert_eq!(w.state_of(id).await, "pending");
        }
        let listed = w.list().await;
        assert!(listed.iter().all(|s| s.get("decided_by").is_none()));

        // The other end of a Connection counts the same.
        let res = w
            .act(
                &w.bea,
                &untouched,
                "accept",
                json!({ "ops": [create(&new_id(), "Connection", json!({
                "from": { "Ref": w.b }, "to": { "Ref": spare }
            }))] }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        // A stale Suggestion can still be rejected...
        let res = w.act(&w.bea, &for_connection, "reject", json!({})).await;
        assert_eq!(res.status, StatusCode::OK);
        // ...and once the Card is back, accepted.
        w.app
            .ops(
                &w.admin,
                &w.main,
                json!([{ "Undelete": { "entity": w.a } }]),
            )
            .await;
        let res = w
            .act(
                &w.bea,
                &for_source,
                "accept",
                json!({ "ops": w.source_ops(&new_id(), &new_id(), "10.1/x") }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    }
}

#[tokio::test]
async fn a_connection_suggestion_is_stale_when_its_far_end_is_deleted() {
    let w = world().await;
    let id = w.suggest_connection().await;
    w.app.ops(&w.admin, &w.main, json!([delete_op(&w.b)])).await;
    let stored = w.app.workspace_bytes();
    let res = w
        .act(
            &w.admin,
            &id,
            "accept",
            json!({ "ops": w.connection_ops(&new_id()) }),
        )
        .await;
    assert_eq!(res.status, StatusCode::CONFLICT);
    assert_eq!(res.code(), "stale");
    assert_eq!(w.app.workspace_bytes(), stored);
    assert_eq!(w.state_of(&id).await, "pending");
}

#[tokio::test]
async fn accept_takes_one_to_twenty_ops_of_ordinary_size() {
    let w = world().await;
    let id = w.suggest_source("10.1/x").await;
    let stored = w.app.workspace_bytes();
    let many: Vec<Value> = (0..21)
        .map(|i| create_card(&new_id(), &format!("c{i}")))
        .collect();
    let huge = json!([create(
        &new_id(),
        "Source",
        json!({ "title": { "Text": "x".repeat(100_001) } })
    )]);
    for body in [
        json!({ "ops": [] }),
        json!({ "ops": many }),
        json!({ "ops": huge }),
        json!({}),
        json!({ "ops": "nope" }),
        json!({ "ops": [{ "Explode": {} }] }),
    ] {
        let res = w.act(&w.admin, &id, "accept", body).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{}", res.text);
        assert_eq!(res.code(), "bad_request");
    }
    assert_eq!(w.app.workspace_bytes(), stored);
    assert_eq!(w.state_of(&id).await, "pending");
    // Twenty are fine.
    let twenty: Vec<Value> = (0..20)
        .map(|i| create_card(&new_id(), &format!("c{i}")))
        .collect();
    let res = w
        .act(&w.admin, &id, "accept", json!({ "ops": twenty }))
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body["changes"].as_array().unwrap().len(), 20);

    for action in ["accept", "reject", "reopen"] {
        for unknown in [new_id(), "nope".to_string()] {
            let res = w
                .act(
                    &w.admin,
                    &unknown,
                    action,
                    json!({ "ops": [create_card(&new_id(), "x")] }),
                )
                .await;
            assert_eq!(res.status, StatusCode::NOT_FOUND, "{action} {unknown}");
        }
    }
    assert_eq!(w.board().await["seq"], 22);
}

// ---------------------------------------------------------------- reject, reopen

#[tokio::test]
async fn a_suggestion_is_rejected_and_reopened() {
    for store in stores() {
        let w = world_on(store).await;
        let id = w.suggest_source("10.1/x").await;
        let stored = w.app.workspace_bytes();
        // Only a rejected one can be reopened.
        let res = w.act(&w.bea, &id, "reopen", json!({})).await;
        assert_eq!(
            (res.status, res.code()),
            (StatusCode::CONFLICT, "already_decided")
        );

        w.app.clock.advance(5_000);
        let res = w.act(&w.bea, &id, "reject", json!({})).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        let rejected = res.body["suggestion"].clone();
        assert_eq!(rejected["state"], "rejected");
        assert_eq!(rejected["decided_by"], w.bea_id);
        assert_eq!(rejected["decided_at"], START + 5_000);
        assert_eq!(w.list().await, vec![rejected]);
        assert_eq!(
            w.app.tool_ok(&w.token, "list_suggestions", json!({})).await,
            json!([]),
            "the AI is shown only pending ones"
        );
        for (action, body) in [
            ("reject", json!({})),
            (
                "accept",
                json!({ "ops": w.source_ops(&new_id(), &new_id(), "10.1/x") }),
            ),
        ] {
            let res = w.act(&w.admin, &id, action, body).await;
            assert_eq!(
                (res.status, res.code()),
                (StatusCode::CONFLICT, "already_decided")
            );
        }

        // Undo, by anyone.
        let res = w.act(&w.admin, &id, "reopen", json!({})).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        let reopened = res.body["suggestion"].clone();
        assert_eq!(reopened["state"], "pending");
        assert!(reopened.get("decided_by").is_none());
        assert!(reopened.get("decided_at").is_none());
        assert_eq!(w.list().await, vec![reopened]);
        assert_eq!(
            w.app.workspace_bytes(),
            stored,
            "none of this touches the Workspace"
        );

        // And then it can be accepted.
        let res = w
            .act(
                &w.bea,
                &id,
                "accept",
                json!({ "ops": w.source_ops(&new_id(), &new_id(), "10.1/x") }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    }
}

// ---------------------------------------------------------------- who may

#[tokio::test]
async fn guests_and_strangers_are_refused_on_every_suggestions_route() {
    let w = world().await;
    let id = w.suggest_source("10.1/x").await;
    let stored = w.app.workspace_bytes();
    let ops = json!({ "ops": w.source_ops(&new_id(), &new_id(), "10.1/x") });
    for (who, status, code) in [
        (Some(w.guest.as_str()), StatusCode::FORBIDDEN, "forbidden"),
        (None, StatusCode::UNAUTHORIZED, "not_signed_in"),
    ] {
        // Also for Branches and Suggestions that do not exist: nothing is revealed.
        for branch in [w.main.clone(), new_id()] {
            let res = w
                .app
                .get(&format!("/api/suggestions?branch={branch}"), who)
                .await;
            assert_eq!((res.status, res.code()), (status, code));
            assert!(res.body.get("suggestions").is_none());
        }
        let res = w.app.get("/api/suggestions", who).await;
        assert_eq!((res.status, res.code()), (status, code));
        for target in [id.clone(), new_id()] {
            for action in ["accept", "reject", "reopen"] {
                let res = w
                    .app
                    .post(
                        &format!("/api/suggestions/{target}/{action}"),
                        who,
                        ops.clone(),
                    )
                    .await;
                assert_eq!((res.status, res.code()), (status, code), "{action}");
            }
        }
    }
    assert_eq!(w.state_of(&id).await, "pending");
    assert_eq!(w.app.workspace_bytes(), stored);
    // There is no route that creates one.
    for path in [
        "/api/suggestions".to_string(),
        format!("/api/suggestions?branch={}", w.main),
    ] {
        let res = w
            .app
            .post(
                &path,
                Some(&w.admin),
                json!({ "kind": "source", "card": w.a, "reason": "r" }),
            )
            .await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "{path}");
    }
    assert_eq!(w.list().await.len(), 1);
    // A Guest's Board reads show nothing of Suggestions either.
    let board = w
        .app
        .get(&format!("/api/branches/{}/board", w.main), Some(&w.guest))
        .await;
    assert!(!board.text.contains("10.1/x"));
}

// ---------------------------------------------------------------- listing

#[tokio::test]
async fn the_list_is_per_branch_newest_first_and_keeps_decided_ones_for_a_week() {
    for store in stores() {
        let w = world_on(store).await;
        let res = w.app.get("/api/suggestions", Some(&w.admin)).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST);
        for unknown in [new_id(), "nope".to_string()] {
            let res = w
                .app
                .get(
                    &format!("/api/suggestions?branch={unknown}"),
                    Some(&w.admin),
                )
                .await;
            assert_eq!(res.status, StatusCode::NOT_FOUND);
        }
        assert!(w.list().await.is_empty());

        let old = w.suggest_source("10.1/old").await;
        w.app.clock.advance(1_000);
        let rejected = w.suggest_source("10.1/rejected").await;
        w.app.clock.advance(1_000);
        let accepted = w.suggest_connection().await;
        w.app.clock.advance(1_000);
        let ids = |list: &[Value]| -> Vec<String> {
            list.iter()
                .map(|s| s["id"].as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(
            ids(&w.list().await),
            [accepted.clone(), rejected.clone(), old.clone()]
        );
        // Bea sees the same list.
        let beas = w
            .app
            .get(&format!("/api/suggestions?branch={}", w.main), Some(&w.bea))
            .await;
        assert_eq!(beas.body["suggestions"], json!(w.list().await));

        // Decided at START + 3 s.
        w.act(&w.admin, &rejected, "reject", json!({})).await;
        let res = w
            .act(
                &w.admin,
                &accepted,
                "accept",
                json!({ "ops": w.connection_ops(&new_id()) }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        // Deciding does not reorder.
        assert_eq!(
            ids(&w.list().await),
            [accepted.clone(), rejected.clone(), old.clone()]
        );

        // Just inside the week they are still listed; at the week they are gone, and the
        // pending one stays however old it is.
        w.app.clock.advance(WEEK - 1);
        assert_eq!(w.list().await.len(), 3);
        w.app.clock.advance(1);
        assert_eq!(ids(&w.list().await), std::slice::from_ref(&old));
        w.app.clock.advance(2 * WEEK);
        assert_eq!(ids(&w.list().await), std::slice::from_ref(&old));
        // Out of the list is not out of existence: it is still decided.
        let res = w.act(&w.admin, &accepted, "reject", json!({})).await;
        assert_eq!(res.code(), "already_decided");
        // A rejected one reopened after the window is pending, so listed again.
        let res = w.act(&w.admin, &rejected, "reopen", json!({})).await;
        assert_eq!(res.status, StatusCode::OK);
        assert_eq!(ids(&w.list().await), [rejected.clone(), old.clone()]);
    }
}

#[tokio::test]
async fn removing_a_member_keeps_the_suggestions_their_ai_made() {
    for store in stores() {
        let w = world_on(store).await;
        let beas = w.app.access_token(&w.bea, "bea").await;
        let made = w
            .app
            .tool_ok(
                &beas,
                "suggest_source",
                json!({ "card": w.a, "doi": "10.1/bea", "reason": "Bea's AI says so." }),
            )
            .await;
        let res = w
            .app
            .delete(&format!("/api/members/{}", w.bea_id), Some(&w.admin))
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        let list = w.list().await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["id"], made["id"]);
        assert_eq!(list[0]["created_by"], w.bea_id);
        assert_eq!(list[0]["state"], "pending");
        // It can still be accepted.
        let id = made["id"].as_str().unwrap();
        let res = w
            .act(
                &w.admin,
                id,
                "accept",
                json!({ "ops": w.source_ops(&new_id(), &new_id(), "10.1/bea") }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    }
}

// ---------------------------------------------------------------- storage

#[tokio::test]
async fn tokens_and_suggestions_survive_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("infall.db");
    let (token, a, main, pending, accepted, rejected, list, tokens) = {
        let w = world_on(Arc::new(SqliteStore::open(&path).unwrap())).await;
        let pending = w.suggest_source("10.1/pending").await;
        let rejected = w.suggest_source("10.1/rejected").await;
        let accepted = w.suggest_connection().await;
        w.act(&w.bea, &rejected, "reject", json!({})).await;
        let res = w
            .act(
                &w.bea,
                &accepted,
                "accept",
                json!({ "ops": w.connection_ops(&new_id()) }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        let list = w.list().await;
        let tokens = w.app.get("/api/tokens", Some(&w.admin)).await.body;
        (
            w.token.clone(),
            w.a.clone(),
            w.main.clone(),
            pending,
            accepted,
            rejected,
            list,
            tokens,
        )
    };

    let app = TestApp::with_store(Arc::new(SqliteStore::open(&path).unwrap()));
    let admin = app.login("admin@example.org", PASSWORD).await.cookie();
    assert_eq!(app.get("/api/tokens", Some(&admin)).await.body, tokens);
    let after = app
        .get(&format!("/api/suggestions?branch={main}"), Some(&admin))
        .await;
    assert_eq!(after.body["suggestions"], json!(list));
    let state = |id: &str| {
        list.iter().find(|s| s["id"] == id).unwrap()["state"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert_eq!(
        (state(&pending), state(&accepted), state(&rejected)),
        ("pending".into(), "accepted".into(), "rejected".into())
    );
    // The old token still works, sees the accepted Connection and the pending Suggestion.
    let card = app.tool_ok(&token, "get_card", json!({ "card": a })).await;
    assert_eq!(card["connections"].as_array().unwrap().len(), 1);
    let waiting = app.tool_ok(&token, "list_suggestions", json!({})).await;
    assert_eq!(waiting.as_array().unwrap().len(), 1);
    assert_eq!(waiting[0]["id"], pending);
    // The duplicate rule still knows the pending one.
    let again = app
        .tool_ok(
            &token,
            "suggest_source",
            json!({ "card": a, "doi": "10.1/pending", "reason": "Again." }),
        )
        .await;
    assert_eq!(again["id"], pending);
    let res = app
        .post(
            &format!("/api/suggestions/{rejected}/reopen"),
            Some(&admin),
            json!({}),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
}

/// The schema a database file had after M4 (`user_version` 2).
const M4_SCHEMA: &str = "
CREATE TABLE members (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    color TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    access_until INTEGER,
    created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX sessions_member ON sessions(member_id);
CREATE TABLE invites (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    access_until INTEGER,
    expires_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    used_at INTEGER
);
CREATE TABLE workspace (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    json TEXT NOT NULL
);
CREATE TABLE todos (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    done INTEGER NOT NULL,
    done_at INTEGER,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    card_id TEXT,
    card_title TEXT,
    card_branch TEXT
);
CREATE INDEX todos_owner ON todos(owner);
PRAGMA user_version = 2;
";

#[tokio::test]
async fn a_database_file_from_before_m5_upgrades_in_place_and_keeps_its_data() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("infall.db");

    // An M4 file with an account, a To-do and a Board holding one Card.
    let scratch = MemoryStore::new();
    let ada =
        infall_server::create_admin(&scratch, "admin@example.org", "Ada Admin", PASSWORD, START)
            .unwrap();
    let (mut ws, main) = infall_core::Workspace::new();
    let card = new_id();
    let ops: Vec<infall_core::Op> =
        serde_json::from_value(json!([create_card(&card, "From M4")])).unwrap();
    ws.record_all(main, ada.id, START, ops).unwrap();
    let todo_id = new_id();
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(M4_SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO members (id, email, name, role, color, password_hash, access_until, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                ada.id.0.to_string(),
                ada.email,
                ada.name,
                ada.role.as_str(),
                ada.color,
                ada.password_hash,
                ada.access_until,
                ada.created_at
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO workspace (id, json) VALUES (1, ?1)",
            rusqlite::params![serde_json::to_string(&ws).unwrap()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO todos (id, owner, text, done, created_by, created_at)
             VALUES (?1, ?2, 'Kept from M4', 0, ?2, ?3)",
            rusqlite::params![todo_id, ada.id.0.to_string(), START],
        )
        .unwrap();
        let new_tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('access_tokens', 'suggestions')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(new_tables, 0);
    }
    let version = |path: &std::path::Path| -> i64 {
        rusqlite::Connection::open(path)
            .unwrap()
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(version(&path), 2);

    let (token, suggestion) = {
        let app = TestApp::with_store(Arc::new(SqliteStore::open(&path).unwrap()));
        let res = app.login("admin@example.org", PASSWORD).await;
        assert_eq!(res.status, StatusCode::OK, "the account is still there");
        let cookie = res.cookie();
        assert_eq!(app.main_branch(&cookie).await, main.0.to_string());
        let board = app
            .get(&format!("/api/branches/{}/board", main.0), Some(&cookie))
            .await;
        assert_eq!(board.body["seq"], 1);
        assert_eq!(
            board.body["entities"][&card]["fields"]["title"],
            json!({ "Text": "From M4" })
        );
        let todos = app.get("/api/todos", Some(&cookie)).await;
        assert_eq!(todos.body["todos"][0]["id"], todo_id);
        assert_eq!(todos.body["todos"][0]["text"], "Kept from M4");

        // The new tables are there and work.
        assert_eq!(
            app.get("/api/tokens", Some(&cookie)).await.body,
            json!({ "tokens": [] })
        );
        let list = app
            .get(
                &format!("/api/suggestions?branch={}", main.0),
                Some(&cookie),
            )
            .await;
        assert_eq!(list.body, json!({ "suggestions": [] }));
        let token = app.access_token(&cookie, "after the upgrade").await;
        let cards = app.tool_ok(&token, "list_cards", json!({})).await;
        assert_eq!(cards["cards"][0]["title"], "From M4");
        let made = app
            .tool_ok(
                &token,
                "suggest_source",
                json!({ "card": card, "doi": "10.1/m5", "reason": "After the upgrade." }),
            )
            .await;
        (token, made["id"].as_str().unwrap().to_string())
    };
    assert_eq!(version(&path), SCHEMA_VERSION);

    // Opening the upgraded file again changes nothing.
    let app = TestApp::with_store(Arc::new(SqliteStore::open(&path).unwrap()));
    let cookie = app.login("admin@example.org", PASSWORD).await.cookie();
    let list = app
        .get(
            &format!("/api/suggestions?branch={}", main.0),
            Some(&cookie),
        )
        .await;
    assert_eq!(list.body["suggestions"][0]["id"], suggestion);
    assert_eq!(
        app.rpc(&token, "ping", json!({})).await.status,
        StatusCode::OK
    );
    assert_eq!(
        app.get("/api/todos", Some(&cookie)).await.body["todos"][0]["id"],
        todo_id
    );
    assert_eq!(version(&path), SCHEMA_VERSION);
}

#[tokio::test]
async fn accepting_is_one_transaction_with_the_workspace() {
    // The store marks the Suggestion and writes the snapshot together, or does neither.
    for store in stores() {
        let w = world_on(store).await;
        let id = w.suggest_source("10.1/x").await;
        let uuid: uuid::Uuid = id.parse().unwrap();
        let by = infall_core::MemberId(w.bea_id.parse().unwrap());
        let before = w.app.workspace_bytes();
        let mut next = w.app.store.load_workspace().unwrap().unwrap();
        let ops: Vec<infall_core::Op> =
            serde_json::from_value(json!([create_card(&new_id(), "Extra")])).unwrap();
        let main = infall_core::BranchId(w.main.parse().unwrap());
        next.record_all(main, by, START, ops).unwrap();

        // Not pending (here: unknown, then rejected): nothing is written.
        assert!(
            !w.app
                .store
                .save_workspace_accepting(&next, uuid::Uuid::new_v4(), by, START)
                .unwrap()
        );
        assert_eq!(w.app.workspace_bytes(), before);
        w.act(&w.admin, &id, "reject", json!({})).await;
        assert!(
            !w.app
                .store
                .save_workspace_accepting(&next, uuid, by, START)
                .unwrap()
        );
        assert_eq!(w.app.workspace_bytes(), before);
        assert_eq!(w.state_of(&id).await, "rejected");
        // Pending: both.
        w.act(&w.admin, &id, "reopen", json!({})).await;
        assert!(
            w.app
                .store
                .save_workspace_accepting(&next, uuid, by, START + 9)
                .unwrap()
        );
        assert_ne!(w.app.workspace_bytes(), before);
        let stored = w.app.store.suggestion(uuid).unwrap().unwrap();
        assert_eq!(stored.decided_by, Some(by));
        assert_eq!(stored.decided_at, Some(START + 9));
    }
}
