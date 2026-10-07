//! What a Guest may read over HTTP from M6 (contract §13): the present Board of `main`
//! without tombstones, no Changes; and the invite lookup that says until when.

mod common;

use axum::http::StatusCode;
use common::*;
use serde_json::{Value, json};

const DAY: i64 = 24 * 60 * 60 * 1000;

fn reference(id: &str) -> Value {
    json!({ "Ref": id })
}

fn text(s: &str) -> Value {
    json!({ "Text": s })
}

fn connection(id: &str, from: &str, to: &str) -> Value {
    create(
        id,
        "Connection",
        json!({ "from": reference(from), "to": reference(to) }),
    )
}

fn block(id: &str, card: &str) -> Value {
    create(
        id,
        "Block",
        json!({ "card": reference(card), "type": text("text"), "text": text("Words"), "order": text("a") }),
    )
}

fn attachment(id: &str, card: &str, source: &str) -> Value {
    create(
        id,
        "Attachment",
        json!({ "card": reference(card), "source": reference(source) }),
    )
}

async fn board(app: &TestApp, cookie: &str, main: &str) -> Value {
    let res = app
        .get(&format!("/api/branches/{main}/board"), Some(cookie))
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    res.body
}

fn ids(board: &Value) -> Vec<String> {
    board["entities"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect()
}

#[tokio::test]
async fn a_guest_gets_only_the_visible_entities_and_a_member_gets_all() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let bea = app.join(&admin, "bea@example.org", "member", None).await;
    let guest = app
        .join(&admin, "g@example.org", "guest", Some(START + DAY))
        .await;
    let main = app.main_branch(&admin).await;

    // Kept: Cards `a` and `c`, a Connection between them, a Block of `a`, a Source and its
    // Attachment to `a`.
    let (a, c, a_to_c, block_a, kept_source, kept_attachment) =
        (new_id(), new_id(), new_id(), new_id(), new_id(), new_id());
    // Gone or pointing at something gone: Card `b`, the Connection to it, its Block, a
    // Source and the Attachment to it.
    let (b, a_to_b, block_b, gone_source, gone_attachment) =
        (new_id(), new_id(), new_id(), new_id(), new_id());
    app.ops(
        &admin,
        &main,
        json!([
            create_card(&a, "A"),
            create_card(&b, "B"),
            create_card(&c, "C"),
            connection(&a_to_c, &a, &c),
            connection(&a_to_b, &a, &b),
            block(&block_a, &a),
            block(&block_b, &b),
            create(&kept_source, "Source", json!({ "doi": text("10.1/kept") })),
            create(&gone_source, "Source", json!({ "doi": text("10.1/gone") })),
            attachment(&kept_attachment, &a, &kept_source),
            attachment(&gone_attachment, &a, &gone_source),
        ]),
    )
    .await;

    // Nothing deleted yet: a Guest sees what a Member sees.
    let full = board(&app, &bea, &main).await;
    assert_eq!(ids(&full).len(), 11);
    assert_eq!(board(&app, &guest, &main).await, full);

    app.ops(
        &admin,
        &main,
        json!([delete_op(&b), delete_op(&gone_source)]),
    )
    .await;

    let kept = [&a, &c, &a_to_c, &block_a, &kept_source, &kept_attachment];
    let gone = [&b, &a_to_b, &block_b, &gone_source, &gone_attachment];
    for (who, cookie) in [("member", &bea), ("admin", &admin)] {
        let view = board(&app, cookie, &main).await;
        for id in kept.iter().chain(&gone) {
            assert!(
                view["entities"][id.as_str()].is_object(),
                "{who} lacks {id}"
            );
        }
        assert_eq!(ids(&view).len(), 11, "{who}");
        // The tombstones are there as tombstones; what points at them is itself live.
        assert_eq!(view["entities"][b.as_str()]["deleted"], true);
        assert_eq!(view["entities"][gone_source.as_str()]["deleted"], true);
        for id in [&a_to_b, &block_b, &gone_attachment] {
            assert_eq!(view["entities"][id.as_str()]["deleted"], false, "{id}");
        }
    }

    let member_view = board(&app, &bea, &main).await;
    let guest_view = board(&app, &guest, &main).await;
    let mut expected: Vec<String> = kept.iter().map(|id| id.to_string()).collect();
    expected.sort();
    assert_eq!(ids(&guest_view), expected);
    for id in gone {
        assert!(guest_view["entities"].get(id.as_str()).is_none(), "{id}");
    }
    for id in kept {
        // What a Guest does get is the entity as a Member gets it.
        assert_eq!(
            guest_view["entities"][id.as_str()],
            member_view["entities"][id.as_str()]
        );
        assert_eq!(guest_view["entities"][id.as_str()]["deleted"], false);
    }
    // The same head and Branch for both.
    assert_eq!(guest_view["seq"], 13);
    assert_eq!(guest_view["seq"], member_view["seq"]);
    assert_eq!(guest_view["branch"], member_view["branch"]);
    // Nothing of what was removed is anywhere in what the Guest was sent.
    let sent = guest_view.to_string();
    for id in gone {
        assert!(!sent.contains(id.as_str()), "{id} leaked");
    }
    assert!(!sent.contains("10.1/gone"));

    // Brought back, they are visible again, with everything that hangs on them.
    app.ops(&admin, &main, json!([{ "Undelete": { "entity": b } }]))
        .await;
    let guest_view = board(&app, &guest, &main).await;
    for id in [&b, &a_to_b, &block_b] {
        assert!(guest_view["entities"][id.as_str()].is_object(), "{id}");
    }
    assert!(guest_view["entities"].get(gone_source.as_str()).is_none());
    assert!(
        guest_view["entities"]
            .get(gone_attachment.as_str())
            .is_none()
    );
    assert_eq!(guest_view["seq"], 14);
}

#[tokio::test]
async fn a_guest_cannot_read_changes() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let bea = app.join(&admin, "bea@example.org", "member", None).await;
    let guest = app
        .join(&admin, "g@example.org", "guest", Some(START + DAY))
        .await;
    let main = app.main_branch(&admin).await;
    app.ops(&admin, &main, json!([create_card(&new_id(), "A")]))
        .await;

    for path in [
        format!("/api/branches/{main}/changes"),
        format!("/api/branches/{main}/changes?after=0"),
        format!("/api/branches/{main}/changes?after=1"),
        format!("/api/branches/{main}/changes?after=99"),
        format!("/api/branches/{}/changes", new_id()),
    ] {
        let res = app.get(&path, Some(&guest)).await;
        assert_eq!(res.status, StatusCode::FORBIDDEN, "{path}");
        assert_eq!(res.code(), "forbidden", "{path}");
        assert!(res.body.get("changes").is_none(), "{path}");
    }
    // Members read them as before.
    for cookie in [&admin, &bea] {
        let res = app
            .get(&format!("/api/branches/{main}/changes"), Some(cookie))
            .await;
        assert_eq!(res.status, StatusCode::OK);
        assert_eq!(res.body["seq"], 1);
        assert_eq!(res.body["changes"].as_array().unwrap().len(), 1);
    }
    // And the Guest still reads the Board.
    assert_eq!(board(&app, &guest, &main).await["seq"], 1);
}

#[tokio::test]
async fn a_guest_is_not_told_how_many_checkpoints_main_has() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let guest = app
        .join(&admin, "g@example.org", "guest", Some(START + DAY))
        .await;
    let main = app.main_branch(&admin).await;
    let res = app
        .post(
            &format!("/api/branches/{main}/checkpoints"),
            Some(&admin),
            json!({ "name": "Kick-off" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);

    let seen = app.get("/api/branches", Some(&guest)).await;
    assert_eq!(seen.body["branches"].as_array().unwrap().len(), 1);
    assert_eq!(seen.body["branches"][0]["name"], "main");
    assert_eq!(seen.body["branches"][0]["checkpoints"], 0);
    let full = app.get("/api/branches", Some(&admin)).await;
    assert_eq!(full.body["branches"][0]["checkpoints"], 1);
}

#[tokio::test]
async fn the_invite_lookup_says_until_when_a_guest_has_access() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let until = START + 3 * DAY;
    let guest = app
        .invite(&admin, "g@example.org", "guest", Some(until))
        .await;
    let res = app
        .get(&format!("/api/invites/lookup?token={guest}"), None)
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(
        res.body,
        json!({ "email": "g@example.org", "role": "guest", "access_until": until })
    );

    let member = app.invite(&admin, "m@example.org", "member", None).await;
    let res = app
        .get(&format!("/api/invites/lookup?token={member}"), None)
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(
        res.body,
        json!({ "email": "m@example.org", "role": "member" })
    );
    assert!(res.body.get("access_until").is_none());
}
