//! Access tokens (contract §12): a Member's own tokens under `/api/tokens`, and the bearer
//! check and per-token rate limit of the tool endpoint.
//!
//! A token acts as its Member only on `/mcp`. Nothing here is reachable from the session
//! middleware, so `/api/*` never accepts one; and `bearer_member` never reads a cookie.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::http::header::AUTHORIZATION;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::app::{Shared, blocking};
use crate::auth::{MemberOrAdmin, access_expired, new_token, token_hash};
use crate::error::{ApiError, ApiJson};
use crate::store::{AccessTokenRecord, MemberRecord, Role};

/// Every secret starts with this, so one found in a log or a paste is recognisable.
pub const SECRET_PREFIX: &str = "infall_pat_";
/// The most access tokens one Member may have.
pub const MAX_TOKENS_PER_MEMBER: usize = 10;
const MAX_NAME_CHARS: usize = 60;
/// `last_used_at` is written at most this often.
const TOUCH_EVERY_MS: i64 = 60 * 1000;
/// The most requests one token may make to the tool endpoint within `RATE_WINDOW_MS`.
pub const RATE_MAX_REQUESTS: usize = 120;
const RATE_WINDOW_MS: i64 = 60 * 1000;

/// An access token as its owner sees it: never the secret, never its hash.
#[derive(Serialize)]
struct TokenView {
    id: Uuid,
    name: String,
    created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_used_at: Option<i64>,
}

impl TokenView {
    fn of(t: &AccessTokenRecord) -> TokenView {
        TokenView {
            id: t.id,
            name: t.name.clone(),
            created_at: t.created_at,
            last_used_at: t.last_used_at,
        }
    }
}

/// Checks and trims the name of an access token.
fn clean_name(name: &str) -> Result<String, ApiError> {
    let name = name.trim();
    if name.is_empty()
        || name.chars().count() > MAX_NAME_CHARS
        || name.chars().any(char::is_control)
    {
        return Err(ApiError::BadRequest(format!(
            "The name of an access token must be 1 to {MAX_NAME_CHARS} characters on one line."
        )));
    }
    Ok(name.to_string())
}

pub async fn list_tokens(
    State(st): State<Shared>,
    MemberOrAdmin(who): MemberOrAdmin,
) -> Result<Json<Value>, ApiError> {
    let member = who.id();
    let tokens = blocking(&st, move |s| s.access_tokens(member)).await?;
    let views: Vec<TokenView> = tokens.iter().map(TokenView::of).collect();
    Ok(Json(json!({ "tokens": views })))
}

#[derive(Deserialize)]
pub struct CreateToken {
    name: String,
}

pub async fn create_token(
    State(st): State<Shared>,
    MemberOrAdmin(who): MemberOrAdmin,
    ApiJson(body): ApiJson<CreateToken>,
) -> Result<Json<Value>, ApiError> {
    let name = clean_name(&body.name)?;
    let secret = format!(
        "{SECRET_PREFIX}{}",
        new_token().map_err(ApiError::internal)?
    );
    let token = AccessTokenRecord {
        id: Uuid::new_v4(),
        member: who.id(),
        name,
        token_hash: token_hash(&secret),
        created_at: st.clock.now(),
        last_used_at: None,
    };
    let stored = blocking(&st, {
        let token = token.clone();
        move |s| s.insert_access_token(&token, MAX_TOKENS_PER_MEMBER)
    })
    .await?;
    if !stored {
        return Err(ApiError::BadRequest(format!(
            "You already have {MAX_TOKENS_PER_MEMBER} access tokens. Delete one first."
        )));
    }
    tracing::info!(member = %who.id().0, token = %token.id, "access token created");
    Ok(Json(
        json!({ "token": TokenView::of(&token), "secret": secret }),
    ))
}

pub async fn delete_token(
    State(st): State<Shared>,
    MemberOrAdmin(who): MemberOrAdmin,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let id = Uuid::parse_str(&id).map_err(|_| ApiError::NotFound)?;
    let member = who.id();
    if !blocking(&st, move |s| s.delete_access_token(member, id)).await? {
        return Err(ApiError::NotFound);
    }
    tracing::info!(member = %member.0, token = %id, "access token deleted");
    Ok(Json(json!({})))
}

// ---------------------------------------------------------------- the bearer check

/// Whoever a valid access token acts as on the tool endpoint.
#[derive(Debug, Clone)]
pub struct TokenBearer {
    pub member: MemberRecord,
    pub token: Uuid,
}

/// The secret of `Authorization: Bearer <secret>`, if that is what the header holds.
fn bearer_secret(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(AUTHORIZATION)?.to_str().ok()?;
    let (scheme, secret) = value.split_once(' ')?;
    let secret = secret.trim();
    (scheme.eq_ignore_ascii_case("bearer") && !secret.is_empty()).then_some(secret)
}

/// Resolves the request's bearer token to its Member; `None` when the header is missing
/// or malformed, the token unknown or revoked, or its Member gone or a Guest. Cookies are
/// never looked at. An unknown value costs the same hash and lookup as a known one.
pub async fn bearer_member(
    st: &Shared,
    headers: &HeaderMap,
) -> Result<Option<TokenBearer>, ApiError> {
    let Some(secret) = bearer_secret(headers) else {
        return Ok(None);
    };
    let hash = token_hash(secret);
    let found = blocking(st, move |s| s.access_token_by_hash(&hash)).await?;
    let Some((token, member)) = found else {
        return Ok(None);
    };
    let now = st.clock.now();
    if !secret.starts_with(SECRET_PREFIX)
        || member.role == Role::Guest
        || access_expired(&member, now)
    {
        return Ok(None);
    }
    if token
        .last_used_at
        .is_none_or(|at| now - at >= TOUCH_EVERY_MS)
    {
        let id = token.id;
        blocking(st, move |s| s.touch_access_token(id, now)).await?;
    }
    Ok(Some(TokenBearer {
        member,
        token: token.id,
    }))
}

// ---------------------------------------------------------------- rate limit

/// Requests per key (an access token, or a Member) within the last minute.
pub struct RateLimit {
    max: usize,
    recent: Mutex<HashMap<Uuid, VecDeque<i64>>>,
}

impl Default for RateLimit {
    /// The limit of the tool endpoint: `RATE_MAX_REQUESTS` a minute.
    fn default() -> RateLimit {
        RateLimit::new(RATE_MAX_REQUESTS)
    }
}

impl RateLimit {
    /// A limit of `max` requests a minute per key.
    pub fn new(max: usize) -> RateLimit {
        RateLimit {
            max,
            recent: Mutex::new(HashMap::new()),
        }
    }

    /// Counts one request by `token` at `now`; false when it already made the maximum
    /// within the window (a refused request is not counted).
    pub fn allow(&self, token: Uuid, now: i64) -> bool {
        let mut map = match self.recent.lock() {
            Ok(m) => m,
            Err(poisoned) => poisoned.into_inner(),
        };
        if map.len() > 10_000 {
            map.retain(|_, l| l.back().is_some_and(|&t| t > now - RATE_WINDOW_MS));
        }
        let list = map.entry(token).or_default();
        while list.front().is_some_and(|&t| t <= now - RATE_WINDOW_MS) {
            list.pop_front();
        }
        if list.len() >= self.max {
            return false;
        }
        list.push_back(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn the_bearer_secret_is_read_only_from_a_bearer_authorization_header() {
        let with = |v: &'static str| {
            let mut h = HeaderMap::new();
            h.insert(AUTHORIZATION, HeaderValue::from_static(v));
            h
        };
        assert_eq!(bearer_secret(&with("Bearer abc")), Some("abc"));
        assert_eq!(bearer_secret(&with("bearer  abc ")), Some("abc"));
        assert_eq!(bearer_secret(&with("Basic abc")), None);
        assert_eq!(bearer_secret(&with("Bearer ")), None);
        assert_eq!(bearer_secret(&with("abc")), None);
        assert_eq!(bearer_secret(&HeaderMap::new()), None);
    }

    #[test]
    fn names_are_trimmed_and_limited() {
        assert_eq!(clean_name("  Claude  ").unwrap(), "Claude");
        assert!(clean_name("   ").is_err());
        assert!(clean_name("a\nb").is_err());
        assert!(clean_name(&"x".repeat(60)).is_ok());
        assert!(clean_name(&"x".repeat(61)).is_err());
    }

    #[test]
    fn the_rate_limit_refuses_the_121st_request_until_the_window_moves() {
        let r = RateLimit::default();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        for i in 0..RATE_MAX_REQUESTS as i64 {
            assert!(r.allow(a, i));
        }
        assert!(!r.allow(a, 200));
        assert!(r.allow(b, 200));
        assert!(!r.allow(a, RATE_WINDOW_MS - 1));
        // The first request has left the window; exactly one more fits.
        assert!(r.allow(a, RATE_WINDOW_MS));
        assert!(!r.allow(a, RATE_WINDOW_MS));
    }
}
