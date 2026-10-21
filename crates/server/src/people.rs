//! Members and invites (contract §3 and §6 "People"), including accepting an invite.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::header::SET_COOKIE;
use axum::response::{IntoResponse, Response};
use qoop_core::MemberId;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::app::{Shared, blocking};
use crate::auth::{
    Admin, MemberOrAdmin, check_new_password, hash_password, hashing, new_token, normalize_email,
    start_session, token_hash,
};
use crate::error::{ApiError, ApiJson, ApiQuery};
use crate::live::Hub;
use crate::store::{InviteRecord, MemberRecord, Role, Store, StoreResult};

/// Colours handed out to new accounts, in turn.
pub const PALETTE: [&str; 6] = [
    "oklch(0.76 0.08 35)",
    "oklch(0.76 0.08 240)",
    "oklch(0.78 0.08 160)",
    "oklch(0.80 0.08 85)",
    "oklch(0.76 0.09 320)",
    "oklch(0.78 0.07 200)",
];

/// Invites work for 7 days.
pub const INVITE_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const MAX_NAME_CHARS: usize = 100;
const MAX_EMAIL_CHARS: usize = 254;
/// Why invites are refused in a Local Workspace.
const NO_INVITES: &str = "A Local Workspace has one Member and no invites.";

/// A Member as the API shows it to `viewer`.
#[derive(Serialize)]
pub struct MemberView {
    id: MemberId,
    name: String,
    role: Role,
    color: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    access_until: Option<i64>,
}

impl MemberView {
    /// The email is shown only to the Member themself or to an Admin.
    pub fn of(m: &MemberRecord, viewer: &MemberRecord) -> MemberView {
        let show_email = viewer.id == m.id || viewer.role == Role::Admin;
        MemberView {
            id: m.id,
            name: m.name.clone(),
            role: m.role,
            color: m.color.clone(),
            email: show_email.then(|| m.email.clone()),
            access_until: if m.role == Role::Guest {
                m.access_until
            } else {
                None
            },
        }
    }
}

#[derive(Serialize)]
struct InviteView {
    id: Uuid,
    email: String,
    role: Role,
    #[serde(skip_serializing_if = "Option::is_none")]
    access_until: Option<i64>,
    expires_at: i64,
    created_by: MemberId,
}

impl From<&InviteRecord> for InviteView {
    fn from(i: &InviteRecord) -> InviteView {
        InviteView {
            id: i.id,
            email: i.email.clone(),
            role: i.role,
            access_until: i.access_until,
            expires_at: i.expires_at,
            created_by: i.created_by,
        }
    }
}

/// Checks and normalizes a display name.
pub fn clean_name(name: &str) -> Result<String, ApiError> {
    let name = name.trim();
    if name.is_empty()
        || name.chars().count() > MAX_NAME_CHARS
        || name.chars().any(char::is_control)
    {
        return Err(ApiError::BadRequest(format!(
            "The name must be 1 to {MAX_NAME_CHARS} characters."
        )));
    }
    Ok(name.to_string())
}

/// Checks and normalizes an email address (lowercased, trimmed).
pub fn clean_email(email: &str) -> Result<String, ApiError> {
    let email = normalize_email(email);
    let well_formed = email
        .split_once('@')
        .is_some_and(|(local, domain)| !local.is_empty() && !domain.is_empty())
        && email.chars().count() <= MAX_EMAIL_CHARS
        && !email.chars().any(|c| c.is_whitespace() || c.is_control());
    if !well_formed {
        return Err(ApiError::BadRequest(
            "That is not an email address.".to_string(),
        ));
    }
    Ok(email)
}

/// Builds a new account record with the next palette colour. `email` and `name` must
/// already have passed `clean_email` and `clean_name`. Used by `create-admin` and by
/// accepting an invite.
pub fn new_member(
    store: &dyn Store,
    email: String,
    name: String,
    role: Role,
    access_until: Option<i64>,
    password_hash: String,
    now: i64,
) -> StoreResult<MemberRecord> {
    let color = PALETTE[store.member_count()? % PALETTE.len()].to_string();
    Ok(MemberRecord {
        id: MemberId::new(),
        email,
        name,
        role,
        color,
        password_hash,
        access_until,
        created_at: now,
    })
}

fn parse_id(raw: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(raw).map_err(|_| ApiError::NotFound)
}

// ---------------------------------------------------------------- members

pub async fn list_members(
    State(st): State<Shared>,
    MemberOrAdmin(who): MemberOrAdmin,
) -> Result<Json<Value>, ApiError> {
    let members = blocking(&st, |s| s.members()).await?;
    let views: Vec<MemberView> = members
        .iter()
        .map(|m| MemberView::of(m, &who.member))
        .collect();
    Ok(Json(json!({ "members": views })))
}

pub async fn delete_member(
    State(st): State<Shared>,
    Admin(who): Admin,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    crate::local::refuse(&st, "A Local Workspace has exactly one Member.")?;
    let id = MemberId(parse_id(&id)?);
    if id == who.id() {
        return Err(ApiError::Forbidden("An Admin cannot remove themself."));
    }
    // Their own To-dos go with the account, in the same store transaction.
    let order = st.hub.todo_order.lock().await;
    let (removed, todos_changed) = blocking(&st, move |s| {
        let before = s.todos()?.len();
        let removed = s.delete_member(id)?;
        Ok((removed, s.todos()?.len() != before))
    })
    .await?;
    if !removed {
        return Err(ApiError::NotFound);
    }
    if todos_changed {
        crate::todos::broadcast(&st).await?;
    }
    drop(order);
    Hub::disconnect_member(&st, id);
    tracing::info!(member = %id.0, by = %who.id().0, "member removed");
    Ok(Json(json!({})))
}

// ---------------------------------------------------------------- invites

pub async fn list_invites(
    State(st): State<Shared>,
    MemberOrAdmin(_): MemberOrAdmin,
) -> Result<Json<Value>, ApiError> {
    let now = st.clock.now();
    let invites = blocking(&st, move |s| s.pending_invites(now)).await?;
    let views: Vec<InviteView> = invites.iter().map(InviteView::from).collect();
    Ok(Json(json!({ "invites": views })))
}

#[derive(Deserialize)]
pub struct CreateInvite {
    email: String,
    role: Role,
    access_until: Option<i64>,
}

pub async fn create_invite(
    State(st): State<Shared>,
    Admin(who): Admin,
    ApiJson(body): ApiJson<CreateInvite>,
) -> Result<Json<Value>, ApiError> {
    crate::local::refuse(&st, NO_INVITES)?;
    let now = st.clock.now();
    let email = clean_email(&body.email)?;
    let access_until = match (body.role, body.access_until) {
        (Role::Admin, _) => {
            return Err(ApiError::BadRequest(
                "An invite is for a member or a guest.".to_string(),
            ));
        }
        (Role::Guest, Some(t)) if t > now => Some(t),
        (Role::Guest, _) => {
            return Err(ApiError::BadRequest(
                "A guest invite needs an access_until in the future.".to_string(),
            ));
        }
        (Role::Member, None) => None,
        (Role::Member, Some(_)) => {
            return Err(ApiError::BadRequest(
                "access_until is only for guests.".to_string(),
            ));
        }
    };
    if blocking(&st, {
        let email = email.clone();
        move |s| s.member_by_email(&email)
    })
    .await?
    .is_some()
    {
        return Err(ApiError::EmailTaken);
    }
    let token = new_token().map_err(ApiError::internal)?;
    let invite = InviteRecord {
        id: Uuid::new_v4(),
        token_hash: token_hash(&token),
        email,
        role: body.role,
        access_until,
        expires_at: now + INVITE_TTL_MS,
        created_by: who.id(),
        created_at: now,
        used_at: None,
    };
    blocking(&st, {
        let invite = invite.clone();
        move |s| s.insert_invite(&invite)
    })
    .await?;
    let url = format!("{}/invite/{token}", st.config.public_origin);
    Ok(Json(
        json!({ "invite": InviteView::from(&invite), "url": url }),
    ))
}

pub async fn delete_invite(
    State(st): State<Shared>,
    Admin(_): Admin,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    crate::local::refuse(&st, NO_INVITES)?;
    let id = parse_id(&id)?;
    let now = st.clock.now();
    if !blocking(&st, move |s| s.delete_invite(id, now)).await? {
        return Err(ApiError::NotFound);
    }
    Ok(Json(json!({})))
}

#[derive(Deserialize)]
pub struct LookupQuery {
    token: String,
}

/// The pending invite for `token`: `404` if unknown, `410` if expired or used.
async fn pending_invite(st: &Shared, token: &str) -> Result<InviteRecord, ApiError> {
    let hash = token_hash(token);
    let invite = blocking(st, move |s| s.invite_by_token_hash(&hash))
        .await?
        .ok_or(ApiError::NotFound)?;
    if !invite.is_pending(st.clock.now()) {
        return Err(ApiError::InviteExpired);
    }
    Ok(invite)
}

pub async fn lookup_invite(
    State(st): State<Shared>,
    ApiQuery(q): ApiQuery<LookupQuery>,
) -> Result<Json<Value>, ApiError> {
    let invite = pending_invite(&st, &q.token).await?;
    let mut body = json!({ "email": invite.email, "role": invite.role });
    // Until when a Guest would have access, so the invite screen can say so.
    if invite.role == Role::Guest
        && let Some(until) = invite.access_until
    {
        body["access_until"] = json!(until);
    }
    Ok(Json(body))
}

#[derive(Deserialize)]
pub struct AcceptInvite {
    token: String,
    name: String,
    password: String,
}

pub async fn accept_invite(
    State(st): State<Shared>,
    ApiJson(body): ApiJson<AcceptInvite>,
) -> Result<Response, ApiError> {
    let invite = pending_invite(&st, &body.token).await?;
    check_new_password(&body.password)?;
    let name = clean_name(&body.name)?;
    let password = body.password;
    let phc = hashing(&st, move || hash_password(&password))
        .await?
        .map_err(ApiError::internal)?;
    let now = st.clock.now();
    let member = blocking(&st, move |s| {
        let m = new_member(
            s,
            invite.email,
            name,
            invite.role,
            invite.access_until,
            phc,
            now,
        )?;
        s.accept_invite(invite.id, &m, now)?;
        Ok(m)
    })
    .await?;
    let cookie = start_session(&st, member.id).await?;
    tracing::info!(member = %member.id.0, role = member.role.as_str(), "invite accepted");
    let body = json!({ "member": MemberView::of(&member, &member) });
    Ok(([(SET_COOKIE, cookie)], Json(body)).into_response())
}
