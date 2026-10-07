mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use common::*;
use qoop_core::{MemberId, Workspace};
use qoop_server::store::{
    InviteRecord, MemberRecord, MemoryStore, SqliteStore, Store, StoreError, StoreResult,
};
use serde_json::{Value, json};

struct World {
    app: TestApp,
    admin: String,
    main: String,
    side: String,
    a: String,
    b: String,
    c: String,
}

async fn ops(app: &TestApp, cookie: &str, branch: &str, ops: Value) {
    let res = app
        .post(
            &format!("/api/branches/{branch}/ops"),
            Some(cookie),
            json!({ "ops": ops }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
}

async fn fork(app: &TestApp, cookie: &str, name: &str, from: &str, seq: u64) -> String {
    let res = app
        .post(
            "/api/branches",
            Some(cookie),
            json!({ "name": name, "from": { "branch": from, "seq": seq } }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    res.body["branch"]["id"].as_str().unwrap().to_string()
}

fn delete(id: &str) -> Value {
    json!({ "Delete": { "entity": id } })
}

/// Cards A, B and C on main (three Changes) and a Branch `side` forked at that head.
async fn world_on(app: TestApp) -> World {
    let admin = app.admin().await;
    let main = app.main_branch(&admin).await;
    let (a, b, c) = (new_id(), new_id(), new_id());
    ops(
        &app,
        &admin,
        &main,
        json!([
            create_card(&a, "A"),
            create_card(&b, "B"),
            create_card(&c, "C")
        ]),
    )
    .await;
    let side = fork(&app, &admin, "side", &main, 3).await;
    World {
        app,
        admin,
        main,
        side,
        a,
        b,
        c,
    }
}

async fn world() -> World {
    world_on(TestApp::new()).await
}

impl World {
    async fn plan(&self, source: &str, target: &str) -> Res {
        self.app
            .get(
                &format!("/api/merges/plan?source={source}&target={target}"),
                Some(&self.admin),
            )
            .await
    }

    /// The plan for `source` into `target`, which must be given.
    async fn planned(&self, source: &str, target: &str) -> Value {
        let res = self.plan(source, target).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        res.body["plan"].clone()
    }

    async fn merge(&self, body: Value) -> Res {
        self.app.post("/api/merges", Some(&self.admin), body).await
    }

    async fn get(&self, path: String) -> Value {
        let res = self.app.get(&path, Some(&self.admin)).await;
        assert_eq!(res.status, StatusCode::OK, "{path}: {}", res.text);
        res.body
    }

    async fn board(&self, branch: &str) -> Value {
        self.get(format!("/api/branches/{branch}/board")).await
    }

    /// Everything a Merge could change, in one value.
    async fn snapshot(&self) -> Value {
        json!({
            "branches": self.get("/api/branches".to_string()).await,
            "main_changes": self.get(format!("/api/branches/{}/changes", self.main)).await,
            "main_checkpoints": self.get(format!("/api/branches/{}/checkpoints", self.main)).await,
            "side_changes": self.get(format!("/api/branches/{}/changes", self.side)).await,
            "side_checkpoints": self.get(format!("/api/branches/{}/checkpoints", self.side)).await,
        })
    }

    /// side retitles A and adds D; main retitles B. No Conflicts either way.
    async fn diverge_without_conflicts(&self) -> String {
        let d = new_id();
        ops(
            &self.app,
            &self.admin,
            &self.side,
            json!([set_title(&self.a, "A-side"), create_card(&d, "D")]),
        )
        .await;
        ops(
            &self.app,
            &self.admin,
            &self.main,
            json!([set_title(&self.b, "B-main")]),
        )
        .await;
        d
    }

    /// Three Conflicts for side into main: A's title changed on both; B deleted on
    /// side and retitled on main; C retitled on side and deleted on main.
    async fn diverge_with_conflicts(&self) {
        ops(
            &self.app,
            &self.admin,
            &self.side,
            json!([
                set_title(&self.a, "A-side"),
                delete(&self.b),
                set_title(&self.c, "C-side")
            ]),
        )
        .await;
        ops(
            &self.app,
            &self.admin,
            &self.main,
            json!([
                set_title(&self.a, "A-main"),
                set_title(&self.b, "B-main"),
                delete(&self.c)
            ]),
        )
        .await;
    }

    fn key_a(&self) -> Value {
        json!({ "entity": self.a, "field": "title" })
    }
    fn key_b(&self) -> Value {
        json!({ "entity": self.b, "field": null })
    }
    fn key_c(&self) -> Value {
        json!({ "entity": self.c, "field": null })
    }
}

fn title(board: &Value, id: &str) -> Value {
    board["entities"][id]["fields"]["title"]["Text"].clone()
}

fn conflict_keys(plan: &Value) -> Vec<Value> {
    plan["conflicts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| match (c.get("Field"), c.get("EditVsDelete")) {
            (Some(f), _) => json!({ "entity": f["entity"], "field": f["field"] }),
            (_, Some(e)) => json!({ "entity": e["entity"], "field": null }),
            _ => panic!("unknown conflict {c}"),
        })
        .collect()
}

#[tokio::test]
async fn a_plan_says_what_a_merge_would_do_in_either_direction_and_changes_nothing() {
    let w = world().await;
    let d = w.diverge_without_conflicts().await;
    let before = w.snapshot().await;

    let up = w.plan(&w.side, &w.main).await;
    assert_eq!(up.status, StatusCode::OK, "{}", up.text);
    assert_eq!(
        up.body,
        json!({ "plan": {
            "source": { "branch": w.side, "seq": 2 },
            "target": { "branch": w.main, "seq": 4 },
            "base": { "branch": w.main, "seq": 3 },
            "auto": [create_card(&d, "D"), set_title(&w.a, "A-side")],
            "conflicts": [],
        } })
    );
    let down = w.plan(&w.main, &w.side).await;
    assert_eq!(down.status, StatusCode::OK, "{}", down.text);
    assert_eq!(
        down.body,
        json!({ "plan": {
            "source": { "branch": w.main, "seq": 4 },
            "target": { "branch": w.side, "seq": 2 },
            "base": { "branch": w.main, "seq": 3 },
            "auto": [set_title(&w.b, "B-main")],
            "conflicts": [],
        } })
    );
    // Asking again gives the same answer, and nothing moved.
    assert_eq!(w.plan(&w.side, &w.main).await.body, up.body);
    assert_eq!(w.snapshot().await, before);
}

#[tokio::test]
async fn a_plan_lists_the_conflicts() {
    let w = world().await;
    w.diverge_with_conflicts().await;
    let plan = w.planned(&w.side, &w.main).await;
    assert_eq!(plan["auto"], json!([]));
    let conflicts = plan["conflicts"].as_array().unwrap();
    assert_eq!(conflicts.len(), 3);
    assert!(conflicts.contains(&json!({ "Field": {
        "entity": w.a,
        "field": "title",
        "base": { "Text": "A" },
        "source": { "Text": "A-side" },
        "target": { "Text": "A-main" },
    } })));
    assert!(
        conflicts.contains(&json!({ "EditVsDelete": { "entity": w.b, "deleted_on": "Source" } }))
    );
    assert!(
        conflicts.contains(&json!({ "EditVsDelete": { "entity": w.c, "deleted_on": "Target" } }))
    );
}

#[tokio::test]
async fn a_merge_without_conflicts_lands_on_the_target_as_one_batch() {
    let w = world().await;
    let d = w.diverge_without_conflicts().await;
    let author = w.get("/api/me".to_string()).await["member"]["id"].clone();
    let side_before = w.board(&w.side).await;
    let plan = w.planned(&w.side, &w.main).await;
    w.app.clock.advance(7);

    let res = w.merge(json!({ "plan": plan, "decisions": [] })).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body["seq"], 6);
    assert!(res.body.get("checkpoint").is_none());
    let changes = res.body["changes"].as_array().unwrap();
    assert_eq!(changes.len(), 2);
    assert_eq!(changes[0]["op"], create_card(&d, "D"));
    assert_eq!(changes[1]["op"], set_title(&w.a, "A-side"));
    let batch = &changes[0]["origin"]["Merge"]["batch"];
    assert!(batch.is_string());
    for change in changes {
        assert_eq!(change["author"], author);
        assert_eq!(change["at"], START + 7);
        assert_eq!(
            change["origin"],
            json!({ "Merge": { "batch": batch, "source": { "branch": w.side, "seq": 2 } } })
        );
    }

    // The target has source's work and keeps its own; the source is untouched.
    let main = w.board(&w.main).await;
    assert_eq!(main["seq"], 6);
    assert_eq!(title(&main, &w.a), "A-side");
    assert_eq!(title(&main, &w.b), "B-main");
    assert_eq!(title(&main, &d), "D");
    assert_eq!(w.board(&w.side).await, side_before);
    let listed = w
        .get(format!("/api/branches/{}/changes?after=4", w.main))
        .await;
    assert_eq!(listed["changes"], res.body["changes"]);
    assert_eq!(
        w.get(format!("/api/branches/{}/checkpoints", w.main)).await,
        json!({ "checkpoints": [] })
    );

    // The Branches now agree up to side's head: nothing more to bring over.
    let again = w.planned(&w.side, &w.main).await;
    assert_eq!(again["base"], json!({ "branch": w.side, "seq": 2 }));
    assert_eq!(again["auto"], json!([]));
    assert_eq!(again["conflicts"], json!([]));
    // An empty Merge is fine and appends nothing.
    let res = w.merge(json!({ "plan": again, "decisions": [] })).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body, json!({ "seq": 6, "changes": [] }));

    // The other direction brings main's own work to side.
    let down = w.planned(&w.main, &w.side).await;
    assert_eq!(down["auto"], json!([set_title(&w.b, "B-main")]));
    let res = w.merge(json!({ "plan": down, "decisions": [] })).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body["seq"], 3);
    assert_eq!(
        res.body["changes"][0]["origin"]["Merge"]["source"],
        json!({ "branch": w.main, "seq": 6 })
    );
    let side = w.board(&w.side).await;
    assert_eq!(title(&side, &w.b), "B-main");
    assert_eq!(side["entities"], w.board(&w.main).await["entities"]);
}

#[tokio::test]
async fn a_merge_can_leave_a_checkpoint_at_the_moment_before_it() {
    let w = world().await;
    w.diverge_without_conflicts().await;
    let author = w.get("/api/me".to_string()).await["member"]["id"].clone();
    let before = w.board(&w.main).await;
    let plan = w.planned(&w.side, &w.main).await;
    w.app.clock.advance(3);

    let res = w
        .merge(json!({ "plan": plan, "decisions": [], "checkpoint": "  before side  " }))
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body["seq"], 6);
    assert_eq!(
        res.body["checkpoint"],
        json!({
            "name": "before side",
            "moment": { "branch": w.main, "seq": 4 },
            "author": author,
            "at": START + 3,
        })
    );
    assert_eq!(
        w.get(format!("/api/branches/{}/checkpoints", w.main)).await,
        json!({ "checkpoints": [res.body["checkpoint"]] })
    );
    assert_eq!(
        w.get(format!("/api/branches/{}/checkpoints", w.side)).await,
        json!({ "checkpoints": [] })
    );
    // The Board at the Checkpoint is the target as it was before the Merge.
    let at = w.get(format!("/api/branches/{}/board?at=4", w.main)).await;
    assert_eq!(at, before);
    assert_ne!(w.board(&w.main).await["entities"], before["entities"]);

    // A Merge that brings nothing can still leave one, at the unchanged head.
    let again = w.planned(&w.side, &w.main).await;
    let res = w
        .merge(json!({ "plan": again, "decisions": [], "checkpoint": "nothing new" }))
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body["changes"], json!([]));
    assert_eq!(
        res.body["checkpoint"]["moment"],
        json!({ "branch": w.main, "seq": 6 })
    );
}

#[tokio::test]
async fn conflicts_decided_for_the_source_end_up_as_the_source_has_them() {
    let w = world().await;
    w.diverge_with_conflicts().await;
    let plan = w.planned(&w.side, &w.main).await;
    let res = w
        .merge(json!({ "plan": plan, "decisions": [
            [w.key_a(), "TakeSource"],
            [w.key_b(), "TakeSource"],
            [w.key_c(), "TakeSource"],
        ] }))
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert!(!res.body["changes"].as_array().unwrap().is_empty());
    let main = w.board(&w.main).await;
    assert_eq!(main["seq"], res.body["seq"]);
    assert_eq!(title(&main, &w.a), "A-side");
    assert_eq!(main["entities"][&w.b]["deleted"], true);
    assert_eq!(main["entities"][&w.c]["deleted"], false);
    assert_eq!(title(&main, &w.c), "C-side");
}

#[tokio::test]
async fn conflicts_decided_for_the_target_leave_it_as_it_is() {
    let w = world().await;
    w.diverge_with_conflicts().await;
    let before = w.board(&w.main).await;
    let plan = w.planned(&w.side, &w.main).await;
    let res = w
        .merge(json!({ "plan": plan, "decisions": [
            [w.key_c(), "TakeTarget"],
            [w.key_a(), "TakeTarget"],
            [w.key_b(), "TakeTarget"],
        ] }))
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body, json!({ "seq": 6, "changes": [] }));
    let main = w.board(&w.main).await;
    assert_eq!(main, before);
    assert_eq!(title(&main, &w.a), "A-main");
    assert_eq!(title(&main, &w.b), "B-main");
    assert_eq!(main["entities"][&w.b]["deleted"], false);
    assert_eq!(main["entities"][&w.c]["deleted"], true);
    // The decided Merge is remembered: the same Conflicts are not raised again.
    let again = w.planned(&w.side, &w.main).await;
    assert_eq!(again["auto"], json!([]));
    assert_eq!(again["conflicts"], json!([]));
}

#[tokio::test]
async fn conflicts_can_be_decided_each_their_own_way_with_a_hand_written_value() {
    let w = world().await;
    w.diverge_with_conflicts().await;
    let plan = w.planned(&w.side, &w.main).await;
    let res = w
        .merge(json!({ "plan": plan, "decisions": [
            [w.key_a(), { "Custom": { "Text": "A-both" } }],
            [w.key_b(), "TakeTarget"],
            [w.key_c(), "TakeSource"],
        ] }))
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let ops: Vec<&Value> = res.body["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| &c["op"])
        .collect();
    assert!(ops.contains(&&set_title(&w.a, "A-both")));
    assert!(ops.contains(&&json!({ "Undelete": { "entity": w.c } })));
    let main = w.board(&w.main).await;
    assert_eq!(title(&main, &w.a), "A-both");
    assert_eq!(main["entities"][&w.b]["deleted"], false);
    assert_eq!(title(&main, &w.b), "B-main");
    assert_eq!(main["entities"][&w.c]["deleted"], false);
    assert_eq!(title(&main, &w.c), "C-side");
    // The source keeps its own view.
    let side = w.board(&w.side).await;
    assert_eq!(title(&side, &w.a), "A-side");
    assert_eq!(side["entities"][&w.b]["deleted"], true);
}

#[tokio::test]
async fn a_merge_with_conflicts_left_undecided_is_refused_with_their_keys() {
    let w = world().await;
    w.diverge_with_conflicts().await;
    let before = w.snapshot().await;
    let plan = w.planned(&w.side, &w.main).await;
    let keys = conflict_keys(&plan);
    assert_eq!(keys.len(), 3);

    let res = w.merge(json!({ "plan": plan, "decisions": [] })).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST, "{}", res.text);
    assert_eq!(res.code(), "undecided");
    assert_eq!(res.body["error"]["detail"], json!(keys));

    let res = w
        .merge(json!({ "plan": plan, "decisions": [[w.key_a(), "TakeSource"]] }))
        .await;
    assert_eq!(res.code(), "undecided");
    let left: Vec<Value> = keys.into_iter().filter(|k| *k != w.key_a()).collect();
    assert_eq!(res.body["error"]["detail"], json!(left));
    assert_eq!(w.snapshot().await, before);
}

#[tokio::test]
async fn decisions_that_cannot_be_used_are_refused_with_their_key() {
    let w = world().await;
    w.diverge_with_conflicts().await;
    let before = w.snapshot().await;
    let plan = w.planned(&w.side, &w.main).await;
    let all =
        |a: Value, b: Value, c: Value| json!([[w.key_a(), a], [w.key_b(), b], [w.key_c(), c]]);
    let take = || json!("TakeSource");

    // A Decision for something that is not a Conflict.
    let stranger = json!({ "entity": new_id(), "field": null });
    let wrong_field = json!({ "entity": w.a, "field": "summary" });
    for key in [stranger, wrong_field] {
        let mut decisions = all(take(), take(), take());
        decisions
            .as_array_mut()
            .unwrap()
            .push(json!([key, "TakeTarget"]));
        let res = w
            .merge(json!({ "plan": plan, "decisions": decisions }))
            .await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{}", res.text);
        assert_eq!(res.code(), "bad_decision");
        assert_eq!(res.body["error"]["detail"], key);
    }

    // The same Conflict decided twice, even the same way.
    let mut decisions = all(take(), take(), take());
    decisions
        .as_array_mut()
        .unwrap()
        .push(json!([w.key_b(), "TakeSource"]));
    let res = w
        .merge(json!({ "plan": plan, "decisions": decisions }))
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST, "{}", res.text);
    assert_eq!(res.code(), "bad_decision");
    assert_eq!(res.body["error"]["detail"], w.key_b());

    // A hand-written value where the choice is between deleted and live.
    let decisions = all(take(), json!({ "Custom": { "Text": "x" } }), take());
    let res = w
        .merge(json!({ "plan": plan, "decisions": decisions }))
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST, "{}", res.text);
    assert_eq!(res.code(), "bad_decision");
    assert_eq!(res.body["error"]["detail"], w.key_b());

    assert_eq!(w.snapshot().await, before);
    // The plan is still good once the Decisions are.
    let res = w
        .merge(json!({ "plan": plan, "decisions": all(take(), take(), take()) }))
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
}

#[tokio::test]
async fn a_hand_written_value_the_board_refuses_is_rejected() {
    let w = world().await;
    w.diverge_with_conflicts().await;
    let before = w.snapshot().await;
    let plan = w.planned(&w.side, &w.main).await;
    let res = w
        .merge(
            json!({ "plan": plan, "checkpoint": "never made", "decisions": [
            [w.key_a(), { "Custom": { "Float": 1.5 } }],
            [w.key_b(), "TakeSource"],
            [w.key_c(), "TakeSource"],
        ] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::CONFLICT, "{}", res.text);
    assert_eq!(res.code(), "rejected");
    assert_eq!(
        res.body["error"]["detail"],
        json!({ "Schema": { "WrongType": { "field": "title" } } })
    );
    assert_eq!(w.snapshot().await, before);
}

#[tokio::test]
async fn a_hand_written_value_over_the_text_limit_is_refused() {
    let w = world().await;
    w.diverge_with_conflicts().await;
    let before = w.snapshot().await;
    let plan = w.planned(&w.side, &w.main).await;
    let long = "x".repeat(100_001);
    let res = w
        .merge(json!({ "plan": plan, "decisions": [
            [w.key_a(), { "Custom": { "Text": long } }],
            [w.key_b(), "TakeSource"],
            [w.key_c(), "TakeSource"],
        ] }))
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST, "{}", res.text);
    assert_eq!(res.code(), "bad_request");
    assert_eq!(w.snapshot().await, before);
}

#[tokio::test]
async fn a_plan_goes_stale_when_either_branch_changes() {
    let w = world().await;
    w.diverge_without_conflicts().await;

    // A Change lands on the source after planning.
    let plan = w.planned(&w.side, &w.main).await;
    ops(
        &w.app,
        &w.admin,
        &w.side,
        json!([set_title(&w.c, "C-side")]),
    )
    .await;
    let before = w.snapshot().await;
    let res = w
        .merge(json!({ "plan": plan, "decisions": [], "checkpoint": "never made" }))
        .await;
    assert_eq!(res.status, StatusCode::CONFLICT, "{}", res.text);
    assert_eq!(res.code(), "stale");
    assert_eq!(res.body["error"]["detail"], Value::Null);
    assert_eq!(w.snapshot().await, before);

    // A Change lands on the target after planning again.
    let plan = w.planned(&w.side, &w.main).await;
    ops(
        &w.app,
        &w.admin,
        &w.main,
        json!([create_card(&new_id(), "E")]),
    )
    .await;
    let before = w.snapshot().await;
    let res = w.merge(json!({ "plan": plan, "decisions": [] })).await;
    assert_eq!(res.status, StatusCode::CONFLICT, "{}", res.text);
    assert_eq!(res.code(), "stale");
    assert_eq!(w.snapshot().await, before);

    // Planned once more, it goes through; the same plan cannot be used twice.
    let plan = w.planned(&w.side, &w.main).await;
    let res = w.merge(json!({ "plan": plan, "decisions": [] })).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let before = w.snapshot().await;
    let res = w.merge(json!({ "plan": plan, "decisions": [] })).await;
    assert_eq!(res.code(), "stale");
    assert_eq!(w.snapshot().await, before);
}

#[tokio::test]
async fn a_plan_that_was_tampered_with_is_stale() {
    let w = world().await;
    let d = w.diverge_without_conflicts().await;
    let before = w.snapshot().await;
    let plan = w.planned(&w.side, &w.main).await;
    assert_eq!(plan["auto"].as_array().unwrap().len(), 2);

    let mut no_auto = plan.clone();
    no_auto["auto"] = json!([]);
    let mut other_auto = plan.clone();
    other_auto["auto"][1] = set_title(&w.a, "something else");
    let mut extra_auto = plan.clone();
    extra_auto["auto"]
        .as_array_mut()
        .unwrap()
        .push(delete(&w.c));
    let mut invented_conflict = plan.clone();
    invented_conflict["conflicts"] =
        json!([{ "EditVsDelete": { "entity": d, "deleted_on": "Source" } }]);
    let mut other_base = plan.clone();
    other_base["base"]["seq"] = json!(2);
    let mut past_head = plan.clone();
    past_head["source"]["seq"] = json!(99);

    for (what, tampered) in [
        ("auto removed", no_auto),
        ("auto altered", other_auto),
        ("auto added", extra_auto),
        ("conflict invented", invented_conflict),
        ("another base", other_base),
        ("source past its head", past_head),
    ] {
        let res = w.merge(json!({ "plan": tampered, "decisions": [] })).await;
        assert_eq!(res.status, StatusCode::CONFLICT, "{what}: {}", res.text);
        assert_eq!(res.code(), "stale", "{what}");
    }
    assert_eq!(w.snapshot().await, before);
    let res = w.merge(json!({ "plan": plan, "decisions": [] })).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
}

#[tokio::test]
async fn a_taken_or_bad_checkpoint_name_refuses_the_merge() {
    let w = world().await;
    w.diverge_without_conflicts().await;
    let res = w
        .app
        .post(
            &format!("/api/branches/{}/checkpoints", w.main),
            Some(&w.admin),
            json!({ "name": "v1" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let before = w.snapshot().await;
    let plan = w.planned(&w.side, &w.main).await;

    let res = w
        .merge(json!({ "plan": plan, "decisions": [], "checkpoint": " v1 " }))
        .await;
    assert_eq!(res.status, StatusCode::CONFLICT, "{}", res.text);
    assert_eq!(res.code(), "name_taken");
    assert_eq!(res.body["error"]["detail"], Value::Null);

    let long = "x".repeat(81);
    for name in ["", "   ", "a\nb", long.as_str()] {
        let res = w
            .merge(json!({ "plan": plan, "decisions": [], "checkpoint": name }))
            .await;
        assert_eq!(
            res.status,
            StatusCode::BAD_REQUEST,
            "{name:?}: {}",
            res.text
        );
        assert_eq!(res.code(), "bad_request", "{name:?}");
    }
    assert_eq!(w.snapshot().await, before);

    // The name is only taken on the target: the same one on the source does not matter.
    let res = w
        .app
        .post(
            &format!("/api/branches/{}/checkpoints", w.side),
            Some(&w.admin),
            json!({ "name": "v2" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let res = w
        .merge(json!({ "plan": plan, "decisions": [], "checkpoint": "v2" }))
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body["checkpoint"]["name"], "v2");
}

#[tokio::test]
async fn only_a_branch_and_its_direct_parent_can_be_merged() {
    let w = world().await;
    let other = fork(&w.app, &w.admin, "other", &w.main, 3).await;
    let grandchild = fork(&w.app, &w.admin, "grandchild", &w.side, 0).await;
    let before = w.snapshot().await;

    for (source, target) in [
        (&w.side, &other),
        (&other, &w.side),
        (&grandchild, &w.main),
        (&w.main, &grandchild),
        (&w.main, &w.main),
    ] {
        let res = w.plan(source, target).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{}", res.text);
        assert_eq!(res.code(), "not_parent_and_child");
        assert_eq!(res.body["error"]["detail"], Value::Null);

        let plan = json!({
            "source": { "branch": source, "seq": 0 },
            "target": { "branch": target, "seq": 0 },
            "base": { "branch": w.main, "seq": 3 },
            "auto": [],
            "conflicts": [],
        });
        let res = w.merge(json!({ "plan": plan, "decisions": [] })).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{}", res.text);
        assert_eq!(res.code(), "not_parent_and_child");
    }
    assert_eq!(w.snapshot().await, before);
    // A grandchild and its own parent are fine.
    assert_eq!(w.plan(&grandchild, &w.side).await.status, StatusCode::OK);
}

#[tokio::test]
async fn unknown_branches_and_malformed_requests_are_refused() {
    let w = world().await;
    w.diverge_without_conflicts().await;
    let before = w.snapshot().await;
    let unknown = new_id();

    for (source, target) in [
        (unknown.as_str(), w.main.as_str()),
        (w.side.as_str(), unknown.as_str()),
        ("not-an-id", w.main.as_str()),
    ] {
        let res = w.plan(source, target).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "{}", res.text);
        assert_eq!(res.code(), "not_found");
    }
    for path in [
        "/api/merges/plan".to_string(),
        format!("/api/merges/plan?source={}", w.side),
        format!("/api/merges/plan?target={}", w.main),
    ] {
        let res = w.app.get(&path, Some(&w.admin)).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{path}");
        assert_eq!(res.code(), "bad_request", "{path}");
    }

    let plan = w.planned(&w.side, &w.main).await;
    for end in ["source", "target"] {
        let mut gone = plan.clone();
        gone[end]["branch"] = json!(unknown);
        let res = w.merge(json!({ "plan": gone, "decisions": [] })).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "{end}: {}", res.text);
        assert_eq!(res.code(), "not_found");
        assert_eq!(res.body["error"]["detail"], Value::Null);
    }
    for body in [
        json!({}),
        json!({ "plan": plan }),
        json!({ "decisions": [] }),
        json!({ "plan": plan, "decisions": {} }),
        json!({ "plan": plan, "decisions": [["nonsense", "TakeSource"]] }),
        json!({ "plan": plan, "decisions": [[{ "entity": w.a, "field": null }, "TakeBoth"]] }),
        json!({ "plan": plan, "decisions": [], "checkpoint": 5 }),
        json!({ "plan": { "source": 1 }, "decisions": [] }),
    ] {
        let res = w.merge(body.clone()).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{body}: {}", res.text);
        assert_eq!(res.code(), "bad_request", "{body}");
    }
    assert_eq!(w.snapshot().await, before);
}

#[tokio::test]
async fn guests_and_signed_out_callers_cannot_plan_or_merge() {
    let w = world().await;
    w.diverge_without_conflicts().await;
    let guest = w
        .app
        .join(&w.admin, "g@example.org", "guest", Some(START + 1_000_000))
        .await;
    let member = w
        .app
        .join(&w.admin, "bea@example.org", "member", None)
        .await;
    let before = w.snapshot().await;
    let plan = w.planned(&w.side, &w.main).await;
    let path = format!("/api/merges/plan?source={}&target={}", w.side, w.main);
    let body = json!({ "plan": plan, "decisions": [] });

    let res = w.app.get(&path, Some(&guest)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN, "{}", res.text);
    assert_eq!(res.code(), "forbidden");
    assert!(res.body.get("plan").is_none());
    // A Guest learns nothing about Branches from the answer either.
    let res = w
        .app
        .get(
            &format!("/api/merges/plan?source={}&target={}", new_id(), w.main),
            Some(&guest),
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    let res = w.app.post("/api/merges", Some(&guest), body.clone()).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN, "{}", res.text);
    assert_eq!(res.code(), "forbidden");

    assert_eq!(
        w.app.get(&path, None).await.status,
        StatusCode::UNAUTHORIZED
    );
    let res = w.app.post("/api/merges", None, body.clone()).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    assert_eq!(w.snapshot().await, before);

    // A Member may do both, and is the author of the Merge.
    let res = w.app.get(&path, Some(&member)).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body["plan"], plan);
    let res = w.app.post("/api/merges", Some(&member), body).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let bea = w.app.get("/api/me", Some(&member)).await.body["member"]["id"].clone();
    assert_eq!(res.body["changes"][0]["author"], bea);
}

#[tokio::test]
async fn a_merge_needs_the_origin_and_request_headers() {
    let w = world().await;
    w.diverge_without_conflicts().await;
    let before = w.snapshot().await;
    let plan = w.planned(&w.side, &w.main).await;
    let body = json!({ "plan": plan, "decisions": [] });
    let base = || {
        Request::builder()
            .method(Method::POST)
            .uri("/api/merges")
            .header(header::COOKIE, &w.admin)
            .header(header::CONTENT_TYPE, "application/json")
    };
    let attempts = [
        ("no Origin", base().header("x-qoop-request", "1")),
        (
            "foreign Origin",
            base()
                .header(header::ORIGIN, "https://evil.example")
                .header("x-qoop-request", "1"),
        ),
        ("no X-Qoop-Request", base().header(header::ORIGIN, ORIGIN)),
    ];
    for (what, req) in attempts {
        let res = w
            .app
            .send(req.body(Body::from(body.to_string())).unwrap())
            .await;
        assert_eq!(res.status, StatusCode::FORBIDDEN, "{what}");
        assert_eq!(res.code(), "forbidden_origin", "{what}");
    }
    assert_eq!(w.snapshot().await, before);
}

#[tokio::test]
async fn a_merge_survives_a_restart_on_the_same_sqlite_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("qoop.db");
    let (mut w, before, merged) = {
        let app = TestApp::with_store(Arc::new(SqliteStore::open(&path).unwrap()));
        let w = world_on(app).await;
        w.diverge_with_conflicts().await;
        let plan = w.planned(&w.side, &w.main).await;
        let res = w
            .merge(
                json!({ "plan": plan, "checkpoint": "before side", "decisions": [
                [w.key_a(), { "Custom": { "Text": "A-both" } }],
                [w.key_b(), "TakeTarget"],
                [w.key_c(), "TakeSource"],
            ] }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        let before = json!({ "all": w.snapshot().await, "main": w.board(&w.main).await });
        (w, before, res.body)
    };
    w.app = TestApp::with_store(Arc::new(SqliteStore::open(&path).unwrap()));
    w.admin = w.app.login("admin@example.org", PASSWORD).await.cookie();

    let after = json!({ "all": w.snapshot().await, "main": w.board(&w.main).await });
    assert_eq!(after, before);
    assert_eq!(title(&after["main"], &w.a), "A-both");
    assert_eq!(
        after["all"]["main_checkpoints"]["checkpoints"],
        json!([merged["checkpoint"]])
    );
    assert_eq!(
        after["all"]["main_changes"]["changes"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["origin"]["Merge"]["source"],
        json!({ "branch": w.side, "seq": 3 })
    );

    // The Merge is still remembered: planning again starts from it and finds nothing.
    let again = w.planned(&w.side, &w.main).await;
    assert_eq!(
        again,
        json!({
            "source": { "branch": w.side, "seq": 3 },
            "target": { "branch": w.main, "seq": merged["seq"] },
            "base": { "branch": w.side, "seq": 3 },
            "auto": [],
            "conflicts": [],
        })
    );
    let res = w.merge(json!({ "plan": again, "decisions": [] })).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body, json!({ "seq": merged["seq"], "changes": [] }));
}

/// A store whose snapshot writes fail while `broken` is set.
struct BreakableStore {
    inner: MemoryStore,
    broken: Arc<AtomicBool>,
}

impl Store for BreakableStore {
    fn load_workspace(&self) -> StoreResult<Option<Workspace>> {
        self.inner.load_workspace()
    }
    fn save_workspace(&self, ws: &Workspace) -> StoreResult<()> {
        if self.broken.load(Ordering::SeqCst) {
            return Err(StoreError::Backend("disk full at /secret/path".to_string()));
        }
        self.inner.save_workspace(ws)
    }
    fn insert_member(&self, m: &MemberRecord) -> StoreResult<()> {
        self.inner.insert_member(m)
    }
    fn member(&self, id: MemberId) -> StoreResult<Option<MemberRecord>> {
        self.inner.member(id)
    }
    fn member_by_email(&self, e: &str) -> StoreResult<Option<MemberRecord>> {
        self.inner.member_by_email(e)
    }
    fn members(&self) -> StoreResult<Vec<MemberRecord>> {
        self.inner.members()
    }
    fn member_count(&self) -> StoreResult<usize> {
        self.inner.member_count()
    }
    fn delete_member(&self, id: MemberId) -> StoreResult<bool> {
        self.inner.delete_member(id)
    }
    fn set_password(&self, id: MemberId, h: &str) -> StoreResult<bool> {
        self.inner.set_password(id, h)
    }
    fn insert_session(&self, t: &str, m: MemberId, e: i64, n: i64) -> StoreResult<()> {
        self.inner.insert_session(t, m, e, n)
    }
    fn session(&self, t: &str, n: i64) -> StoreResult<Option<(MemberRecord, i64)>> {
        self.inner.session(t, n)
    }
    fn extend_session(&self, t: &str, e: i64) -> StoreResult<()> {
        self.inner.extend_session(t, e)
    }
    fn delete_session(&self, t: &str) -> StoreResult<()> {
        self.inner.delete_session(t)
    }
    fn insert_invite(&self, i: &InviteRecord) -> StoreResult<()> {
        self.inner.insert_invite(i)
    }
    fn invite_by_token_hash(&self, t: &str) -> StoreResult<Option<InviteRecord>> {
        self.inner.invite_by_token_hash(t)
    }
    fn pending_invites(&self, n: i64) -> StoreResult<Vec<InviteRecord>> {
        self.inner.pending_invites(n)
    }
    fn delete_invite(&self, id: uuid::Uuid, n: i64) -> StoreResult<bool> {
        self.inner.delete_invite(id, n)
    }
    fn accept_invite(&self, i: uuid::Uuid, m: &MemberRecord, n: i64) -> StoreResult<()> {
        self.inner.accept_invite(i, m, n)
    }

    fn todos(&self) -> qoop_server::store::StoreResult<Vec<qoop_server::store::TodoRecord>> {
        self.inner.todos()
    }
    fn todo(
        &self,
        id: uuid::Uuid,
    ) -> qoop_server::store::StoreResult<Option<qoop_server::store::TodoRecord>> {
        self.inner.todo(id)
    }
    fn insert_todo(
        &self,
        t: &qoop_server::store::TodoRecord,
    ) -> qoop_server::store::StoreResult<bool> {
        self.inner.insert_todo(t)
    }
    fn update_todo(
        &self,
        t: &qoop_server::store::TodoRecord,
    ) -> qoop_server::store::StoreResult<bool> {
        self.inner.update_todo(t)
    }
    fn delete_todo(&self, id: uuid::Uuid) -> qoop_server::store::StoreResult<bool> {
        self.inner.delete_todo(id)
    }

    fn access_tokens(
        &self,
        member: qoop_core::MemberId,
    ) -> qoop_server::store::StoreResult<Vec<qoop_server::store::AccessTokenRecord>> {
        self.inner.access_tokens(member)
    }
    fn insert_access_token(
        &self,
        token: &qoop_server::store::AccessTokenRecord,
        max: usize,
    ) -> qoop_server::store::StoreResult<bool> {
        self.inner.insert_access_token(token, max)
    }
    fn delete_access_token(
        &self,
        member: qoop_core::MemberId,
        id: uuid::Uuid,
    ) -> qoop_server::store::StoreResult<bool> {
        self.inner.delete_access_token(member, id)
    }
    fn access_token_by_hash(
        &self,
        token_hash: &str,
    ) -> qoop_server::store::StoreResult<
        Option<(
            qoop_server::store::AccessTokenRecord,
            qoop_server::store::MemberRecord,
        )>,
    > {
        self.inner.access_token_by_hash(token_hash)
    }
    fn touch_access_token(&self, id: uuid::Uuid, now: i64) -> qoop_server::store::StoreResult<()> {
        self.inner.touch_access_token(id, now)
    }
    fn suggestions(
        &self,
        branch: qoop_core::BranchId,
        decided_after: i64,
    ) -> qoop_server::store::StoreResult<Vec<qoop_server::store::SuggestionRecord>> {
        self.inner.suggestions(branch, decided_after)
    }
    fn suggestion(
        &self,
        id: uuid::Uuid,
    ) -> qoop_server::store::StoreResult<Option<qoop_server::store::SuggestionRecord>> {
        self.inner.suggestion(id)
    }
    fn insert_suggestion(
        &self,
        suggestion: &qoop_server::store::SuggestionRecord,
    ) -> qoop_server::store::StoreResult<()> {
        self.inner.insert_suggestion(suggestion)
    }
    fn decide_suggestion(
        &self,
        id: uuid::Uuid,
        from: qoop_server::store::SuggestionState,
        to: qoop_server::store::SuggestionState,
        decided: Option<(qoop_core::MemberId, i64)>,
    ) -> qoop_server::store::StoreResult<bool> {
        self.inner.decide_suggestion(id, from, to, decided)
    }
    fn save_workspace_accepting(
        &self,
        ws: &Workspace,
        suggestion: uuid::Uuid,
        by: qoop_core::MemberId,
        at: i64,
    ) -> qoop_server::store::StoreResult<bool> {
        if self.broken.load(Ordering::SeqCst) {
            return Err(StoreError::Backend("disk full at /secret/path".to_string()));
        }
        self.inner.save_workspace_accepting(ws, suggestion, by, at)
    }
}

#[tokio::test]
async fn a_failed_persist_leaves_the_merge_undone_and_hides_the_cause() {
    let broken = Arc::new(AtomicBool::new(false));
    let store = BreakableStore {
        inner: MemoryStore::new(),
        broken: broken.clone(),
    };
    let w = world_on(TestApp::with_store(Arc::new(store))).await;
    w.diverge_without_conflicts().await;
    let before = w.snapshot().await;
    let main_before = w.board(&w.main).await;
    let plan = w.planned(&w.side, &w.main).await;
    let body = json!({ "plan": plan, "decisions": [], "checkpoint": "before side" });

    broken.store(true, Ordering::SeqCst);
    let res = w.merge(body.clone()).await;
    assert_eq!(
        res.status,
        StatusCode::INTERNAL_SERVER_ERROR,
        "{}",
        res.text
    );
    assert_eq!(res.code(), "internal");
    assert!(!res.text.contains("secret"), "{}", res.text);
    assert!(!res.text.contains("disk full"));
    assert_eq!(w.snapshot().await, before);
    assert_eq!(w.board(&w.main).await, main_before);
    // Nothing was remembered either: the plan is unchanged and still applies.
    assert_eq!(w.planned(&w.side, &w.main).await, plan);

    broken.store(false, Ordering::SeqCst);
    let res = w.merge(body).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body["seq"], 6);
    assert_eq!(res.body["checkpoint"]["name"], "before side");
}

#[tokio::test]
async fn a_failed_persist_leaves_an_accepted_suggestion_pending_and_hides_the_cause() {
    let broken = Arc::new(AtomicBool::new(false));
    let store = BreakableStore {
        inner: MemoryStore::new(),
        broken: broken.clone(),
    };
    let w = world_on(TestApp::with_store(Arc::new(store))).await;
    let token = w.app.access_token(&w.admin, "tools").await;
    let made = w
        .app
        .tool_ok(
            &token,
            "suggest_connection",
            json!({ "from": w.a, "to": w.b, "reason": "Linked." }),
        )
        .await;
    let path = format!("/api/suggestions/{}/accept", made["id"].as_str().unwrap());
    let body = json!({ "ops": [{ "Create": {
        "entity": new_id(), "kind": "Connection",
        "fields": { "from": { "Ref": w.a }, "to": { "Ref": w.b } }
    } }] });
    let before = w.app.workspace_bytes();
    let main_before = w.board(&w.main).await;

    broken.store(true, Ordering::SeqCst);
    let res = w.app.post(&path, Some(&w.admin), body.clone()).await;
    assert_eq!(
        res.status,
        StatusCode::INTERNAL_SERVER_ERROR,
        "{}",
        res.text
    );
    assert_eq!(res.code(), "internal");
    assert!(!res.text.contains("secret"), "{}", res.text);
    assert!(!res.text.contains("disk full"));
    assert_eq!(w.app.workspace_bytes(), before);
    assert_eq!(w.board(&w.main).await, main_before);
    let list = w
        .app
        .get(
            &format!("/api/suggestions?branch={}", w.main),
            Some(&w.admin),
        )
        .await;
    assert_eq!(list.body["suggestions"][0]["state"], "pending");

    broken.store(false, Ordering::SeqCst);
    let res = w.app.post(&path, Some(&w.admin), body).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body["suggestion"]["state"], "accepted");
}
