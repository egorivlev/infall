mod common;

use axum::http::StatusCode;
use common::*;
use serde_json::json;

const DAY: i64 = 24 * 3600 * 1000;

#[tokio::test]
async fn invite_lookup_accept_then_login() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let res = app
        .post(
            "/api/invites",
            Some(&admin),
            json!({ "email": "Bea@Example.org", "role": "member" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let invite = &res.body["invite"];
    assert_eq!(invite["email"], "bea@example.org");
    assert_eq!(invite["role"], "member");
    assert_eq!(invite["expires_at"], START + 7 * DAY);
    assert!(invite.get("access_until").is_none());
    let url = res.body["url"].as_str().unwrap();
    assert!(url.starts_with("http://localhost:8787/invite/"));
    let token = url.rsplit('/').next().unwrap();
    assert_eq!(token.len(), 43);

    // The token is shown only once: the invite list does not carry it.
    let list = app.get("/api/invites", Some(&admin)).await;
    assert_eq!(list.body["invites"].as_array().unwrap().len(), 1);
    assert!(!list.text.contains(token));

    let res = app
        .get(&format!("/api/invites/lookup?token={token}"), None)
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(
        res.body,
        json!({ "email": "bea@example.org", "role": "member" })
    );

    let res = app
        .post(
            "/api/auth/accept-invite",
            None,
            json!({ "token": token, "name": " Bea ", "password": PASSWORD }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body["member"]["name"], "Bea");
    assert_eq!(res.body["member"]["role"], "member");
    assert_eq!(res.body["member"]["color"], "oklch(0.76 0.08 240)");
    let cookie = res.cookie();
    assert_eq!(
        app.get("/api/me", Some(&cookie)).await.body["member"]["email"],
        "bea@example.org"
    );
    assert_eq!(
        app.login("bea@example.org", PASSWORD).await.status,
        StatusCode::OK
    );
    // Accepted invites are no longer pending.
    let list = app.get("/api/invites", Some(&admin)).await;
    assert!(list.body["invites"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn an_invite_works_once() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let token = app.invite(&admin, "bea@example.org", "member", None).await;
    let accept = |name: &'static str| json!({ "token": token, "name": name, "password": PASSWORD });
    assert_eq!(
        app.post("/api/auth/accept-invite", None, accept("Bea"))
            .await
            .status,
        StatusCode::OK
    );
    let again = app
        .post("/api/auth/accept-invite", None, accept("Mallory"))
        .await;
    assert_eq!(again.status, StatusCode::GONE);
    assert_eq!(again.code(), "invite_expired");
    let lookup = app
        .get(&format!("/api/invites/lookup?token={token}"), None)
        .await;
    assert_eq!(lookup.status, StatusCode::GONE);
}

#[tokio::test]
async fn an_invite_expires_after_seven_days() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let token = app.invite(&admin, "bea@example.org", "member", None).await;
    app.clock.advance(7 * DAY);
    let lookup = app
        .get(&format!("/api/invites/lookup?token={token}"), None)
        .await;
    assert_eq!(lookup.status, StatusCode::GONE);
    let res = app
        .post(
            "/api/auth/accept-invite",
            None,
            json!({ "token": token, "name": "Bea", "password": PASSWORD }),
        )
        .await;
    assert_eq!(res.status, StatusCode::GONE);
    assert!(
        app.get("/api/invites", Some(&admin)).await.body["invites"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn unknown_invite_tokens_are_404() {
    let app = TestApp::new();
    let res = app.get("/api/invites/lookup?token=nope", None).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.code(), "not_found");
    let res = app
        .post(
            "/api/auth/accept-invite",
            None,
            json!({ "token": "nope", "name": "X", "password": PASSWORD }),
        )
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    let res = app.get("/api/invites/lookup", None).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn accepting_needs_a_twelve_character_password_and_leaves_the_invite_usable() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let token = app.invite(&admin, "bea@example.org", "member", None).await;
    let res = app
        .post(
            "/api/auth/accept-invite",
            None,
            json!({ "token": token, "name": "Bea", "password": "elevenchars" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert!(!res.text.contains("elevenchars"));
    let res = app
        .post(
            "/api/auth/accept-invite",
            None,
            json!({ "token": token, "name": "  ", "password": PASSWORD }),
        )
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    let res = app
        .post(
            "/api/auth/accept-invite",
            None,
            json!({ "token": token, "name": "Bea", "password": PASSWORD }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
}

#[tokio::test]
async fn a_guest_invite_requires_a_future_access_until() {
    let app = TestApp::new();
    let admin = app.admin().await;
    for body in [
        json!({ "email": "g@example.org", "role": "guest" }),
        json!({ "email": "g@example.org", "role": "guest", "access_until": START - 1 }),
        json!({ "email": "m@example.org", "role": "member", "access_until": START + DAY }),
        json!({ "email": "a@example.org", "role": "admin" }),
        json!({ "email": "not-an-email", "role": "member" }),
    ] {
        let res = app.post("/api/invites", Some(&admin), body.clone()).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{body}");
    }
    let res = app
        .post(
            "/api/invites",
            Some(&admin),
            json!({ "email": "g@example.org", "role": "guest", "access_until": START + DAY }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body["invite"]["access_until"], START + DAY);
}

#[tokio::test]
async fn inviting_an_existing_email_is_email_taken() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let res = app
        .post(
            "/api/invites",
            Some(&admin),
            json!({ "email": "ADMIN@example.org", "role": "member" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::CONFLICT);
    assert_eq!(res.code(), "email_taken");
}

#[tokio::test]
async fn an_expired_guest_is_signed_out() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let guest = app
        .join(&admin, "g@example.org", "guest", Some(START + DAY))
        .await;
    let me = app.get("/api/me", Some(&guest)).await;
    assert_eq!(me.status, StatusCode::OK);
    assert_eq!(me.body["member"]["access_until"], START + DAY);
    app.clock.advance(DAY);
    let me = app.get("/api/me", Some(&guest)).await;
    assert_eq!(me.status, StatusCode::UNAUTHORIZED);
    assert_eq!(me.code(), "not_signed_in");
    assert_eq!(
        app.login("g@example.org", PASSWORD).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn guests_cannot_use_people_endpoints() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let guest = app
        .join(&admin, "g@example.org", "guest", Some(START + DAY))
        .await;
    for res in [
        app.get("/api/members", Some(&guest)).await,
        app.get("/api/invites", Some(&guest)).await,
        app.post(
            "/api/invites",
            Some(&guest),
            json!({ "email": "x@example.org", "role": "member" }),
        )
        .await,
    ] {
        assert_eq!(res.status, StatusCode::FORBIDDEN);
        assert_eq!(res.code(), "forbidden");
    }
}

#[tokio::test]
async fn members_can_read_people_but_not_change_them() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let member = app.join(&admin, "bea@example.org", "member", None).await;
    let list = app.get("/api/members", Some(&member)).await;
    assert_eq!(list.status, StatusCode::OK);
    let members = list.body["members"].as_array().unwrap();
    assert_eq!(members.len(), 2);
    // Emails are shown only for yourself when you are not an Admin.
    let admin_entry = members.iter().find(|m| m["role"] == "admin").unwrap();
    let me_entry = members.iter().find(|m| m["role"] == "member").unwrap();
    assert!(admin_entry.get("email").is_none());
    assert_eq!(me_entry["email"], "bea@example.org");
    let admin_view = app.get("/api/members", Some(&admin)).await;
    assert!(
        admin_view.body["members"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["email"].is_string())
    );

    assert_eq!(
        app.get("/api/invites", Some(&member)).await.status,
        StatusCode::OK
    );
    let res = app
        .post(
            "/api/invites",
            Some(&member),
            json!({ "email": "x@example.org", "role": "member" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    let admin_id = admin_entry["id"].as_str().unwrap();
    let res = app
        .delete(&format!("/api/members/{admin_id}"), Some(&member))
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn an_admin_cannot_remove_themself() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let me = app.get("/api/me", Some(&admin)).await;
    let id = me.body["member"]["id"].as_str().unwrap();
    let res = app
        .delete(&format!("/api/members/{id}"), Some(&admin))
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(
        app.get("/api/me", Some(&admin)).await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn a_removed_members_session_stops_working() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let member = app.join(&admin, "bea@example.org", "member", None).await;
    let id = app.get("/api/me", Some(&member)).await.body["member"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let res = app
        .delete(&format!("/api/members/{id}"), Some(&admin))
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body, json!({}));
    assert_eq!(
        app.get("/api/me", Some(&member)).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        app.login("bea@example.org", PASSWORD).await.status,
        StatusCode::UNAUTHORIZED
    );
    let again = app
        .delete(&format!("/api/members/{id}"), Some(&admin))
        .await;
    assert_eq!(again.status, StatusCode::NOT_FOUND);
    let bad = app.delete("/api/members/not-a-uuid", Some(&admin)).await;
    assert_eq!(bad.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn an_admin_can_withdraw_a_pending_invite() {
    let app = TestApp::new();
    let admin = app.admin().await;
    let token = app.invite(&admin, "bea@example.org", "member", None).await;
    let list = app.get("/api/invites", Some(&admin)).await;
    let id = list.body["invites"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(
        app.delete(&format!("/api/invites/{id}"), Some(&admin))
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        app.get(&format!("/api/invites/lookup?token={token}"), None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        app.delete(&format!("/api/invites/{id}"), Some(&admin))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn people_endpoints_need_a_session() {
    let app = TestApp::new();
    assert_eq!(
        app.get("/api/members", None).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        app.get("/api/invites", None).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        app.post(
            "/api/invites",
            None,
            json!({ "email": "x@example.org", "role": "member" })
        )
        .await
        .status,
        StatusCode::UNAUTHORIZED
    );
}
