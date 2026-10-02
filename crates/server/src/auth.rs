//! Passwords, tokens, sessions and their cookie, the role extractors, the Origin guard,
//! the login throttle, and the sign-in / sign-out / me handlers.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use argon2::{Argon2, PasswordHasher, PasswordVerifier};
use axum::Json;
use axum::extract::{FromRequestParts, Request, State};
use axum::http::header::{COOKIE, ORIGIN, SET_COOKIE};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, Method};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use qoop_core::MemberId;
use rand::TryRng;
use rand::rngs::SysRng;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::app::{Shared, blocking};
use crate::error::{ApiError, ApiJson};
use crate::people::MemberView;
use crate::store::{MemberRecord, Role};

pub const SESSION_COOKIE: &str = "qoop_session";
/// Sessions last 30 days from their last use.
pub const SESSION_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// A session is extended (and its cookie re-sent) at most this often.
const SESSION_REFRESH_MS: i64 = 24 * 60 * 60 * 1000;
pub const MIN_PASSWORD_CHARS: usize = 12;
pub const MAX_PASSWORD_CHARS: usize = 1024;
const THROTTLE_WINDOW_MS: i64 = 15 * 60 * 1000;
const THROTTLE_MAX_FAILURES: usize = 5;

// ---------------------------------------------------------------- passwords and tokens

/// An Argon2id PHC string with a fresh random salt from the OS.
pub fn hash_password(password: &str) -> Result<String, String> {
    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|h| h.to_string())
        .map_err(|e| format!("password hashing failed: {e}"))
}

/// Constant-time verification by the library; a malformed hash never verifies.
pub fn verify_password(password: &str, phc: &str) -> bool {
    Argon2::default()
        .verify_password(password.as_bytes(), phc)
        .is_ok()
}

/// Enforces the length rules for a new password.
pub fn check_new_password(password: &str) -> Result<(), ApiError> {
    let n = password.chars().count();
    if n < MIN_PASSWORD_CHARS {
        return Err(ApiError::BadRequest(format!(
            "The password must be at least {MIN_PASSWORD_CHARS} characters."
        )));
    }
    if n > MAX_PASSWORD_CHARS {
        return Err(ApiError::BadRequest(format!(
            "The password must be at most {MAX_PASSWORD_CHARS} characters."
        )));
    }
    Ok(())
}

/// 32 bytes from the OS RNG, URL-safe base64 without padding.
pub fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    SysRng
        .try_fill_bytes(&mut bytes)
        .map_err(|e| format!("OS randomness unavailable: {e}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// Lowercase hex SHA-256 of a token; the only form in which tokens are stored.
pub fn token_hash(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Emails are stored and compared trimmed and lowercased.
pub fn normalize_email(email: &str) -> String {
    email.trim().to_lowercase()
}

/// Runs password hashing work off the async threads, a few at a time.
pub async fn hashing<T: Send + 'static>(
    st: &Shared,
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, ApiError> {
    let _permit = st
        .hashing
        .acquire()
        .await
        .map_err(|_| ApiError::internal("hashing semaphore closed"))?;
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| ApiError::internal(format!("hashing task failed: {e}")))
}

// ---------------------------------------------------------------- cookie

fn cookie(value: &str, max_age_secs: i64, secure: bool) -> Result<HeaderValue, ApiError> {
    let secure = if secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{SESSION_COOKIE}={value}; HttpOnly; SameSite=Lax; Path=/; Max-Age={max_age_secs}{secure}"
    ))
    .map_err(ApiError::internal)
}

pub fn session_cookie(token: &str, secure: bool) -> Result<HeaderValue, ApiError> {
    cookie(token, SESSION_TTL_MS / 1000, secure)
}

pub fn clearing_cookie(secure: bool) -> Result<HeaderValue, ApiError> {
    cookie("", 0, secure)
}

/// The `qoop_session` value from the request's `Cookie` headers.
fn cookie_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, value)| *name == SESSION_COOKIE && !value.is_empty())
        .map(|(_, value)| value.to_string())
}

// ---------------------------------------------------------------- sessions

/// The person behind the request's session.
#[derive(Debug, Clone)]
pub struct SignedIn {
    pub member: MemberRecord,
    pub token_hash: String,
}

impl SignedIn {
    pub fn id(&self) -> MemberId {
        self.member.id
    }
}

/// A Guest whose `access_until` has passed counts as signed out.
pub fn access_expired(m: &MemberRecord, now: i64) -> bool {
    m.role == Role::Guest && m.access_until.is_none_or(|until| until <= now)
}

/// Looks up a live session by token hash; `None` if unknown, expired, or an expired Guest.
pub async fn live_session(
    st: &Shared,
    token_hash: String,
) -> Result<Option<(SignedIn, i64)>, ApiError> {
    let now = st.clock.now();
    let found = blocking(st, {
        let token_hash = token_hash.clone();
        move |s| s.session(&token_hash, now)
    })
    .await?;
    Ok(match found {
        Some((member, _)) if access_expired(&member, now) => None,
        Some((member, expires_at)) => Some((SignedIn { member, token_hash }, expires_at)),
        None => None,
    })
}

/// Middleware for `/api`: resolves the session cookie into a `SignedIn` request extension,
/// slides the session's expiry, and re-sends the cookie when it was extended.
pub async fn resolve_session(State(st): State<Shared>, mut req: Request, next: Next) -> Response {
    let Some(token) = cookie_token(req.headers()) else {
        return next.run(req).await;
    };
    let found = match live_session(&st, token_hash(&token)).await {
        Ok(found) => found,
        Err(e) => return e.into_response(),
    };
    let Some((signed_in, expires_at)) = found else {
        return next.run(req).await;
    };
    let now = st.clock.now();
    let mut extended = false;
    if expires_at - now < SESSION_TTL_MS - SESSION_REFRESH_MS {
        let hash = signed_in.token_hash.clone();
        let until = now + SESSION_TTL_MS;
        if let Err(e) = blocking(&st, move |s| s.extend_session(&hash, until)).await {
            return e.into_response();
        }
        extended = true;
    }
    req.extensions_mut().insert(signed_in);
    let mut res = next.run(req).await;
    let handler_set_cookie = res
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .any(|v| v.as_bytes().starts_with(SESSION_COOKIE.as_bytes()));
    if extended && !handler_set_cookie {
        match session_cookie(&token, st.config.secure_cookies()) {
            Ok(v) => {
                res.headers_mut().append(SET_COOKIE, v);
            }
            Err(e) => return e.into_response(),
        }
    }
    res
}

impl<S: Send + Sync> FromRequestParts<S> for SignedIn {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, ApiError> {
        parts
            .extensions
            .get::<SignedIn>()
            .cloned()
            .ok_or(ApiError::NotSignedIn)
    }
}

/// A signed-in Member or Admin (not a Guest).
pub struct MemberOrAdmin(pub SignedIn);

impl<S: Send + Sync> FromRequestParts<S> for MemberOrAdmin {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, s: &S) -> Result<Self, ApiError> {
        let who = SignedIn::from_request_parts(parts, s).await?;
        if who.member.role == Role::Guest {
            return Err(ApiError::Forbidden("Guests cannot do this."));
        }
        Ok(MemberOrAdmin(who))
    }
}

/// A signed-in Admin.
pub struct Admin(pub SignedIn);

impl<S: Send + Sync> FromRequestParts<S> for Admin {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, s: &S) -> Result<Self, ApiError> {
        let who = SignedIn::from_request_parts(parts, s).await?;
        if who.member.role != Role::Admin {
            return Err(ApiError::Forbidden("Only an Admin can do this."));
        }
        Ok(Admin(who))
    }
}

/// Creates a session for `member`; returns the cookie to set.
pub async fn start_session(st: &Shared, member: MemberId) -> Result<HeaderValue, ApiError> {
    let token = new_token().map_err(ApiError::internal)?;
    let hash = token_hash(&token);
    let now = st.clock.now();
    blocking(st, move |s| {
        s.insert_session(&hash, member, now + SESSION_TTL_MS, now)
    })
    .await?;
    session_cookie(&token, st.config.secure_cookies())
}

// ---------------------------------------------------------------- Origin guard

/// Whether the request's `Origin` header is the public or dev origin.
pub fn origin_allowed(st: &Shared, headers: &HeaderMap) -> bool {
    headers
        .get(ORIGIN)
        .and_then(|o| o.to_str().ok())
        .is_some_and(|o| st.config.allows_origin(o))
}

/// Refuses every non-GET/HEAD request without `X-Qoop-Request: 1` and an allowed `Origin`,
/// before any handler runs.
pub async fn origin_guard(State(st): State<Shared>, req: Request, next: Next) -> Response {
    let safe = req.method() == Method::GET || req.method() == Method::HEAD;
    if !safe {
        let marked = req
            .headers()
            .get("x-qoop-request")
            .is_some_and(|v| v.as_bytes() == b"1");
        if !marked || !origin_allowed(&st, req.headers()) {
            return ApiError::ForbiddenOrigin.into_response();
        }
    }
    next.run(req).await
}

// ---------------------------------------------------------------- throttle

/// Failed logins per email within the last 15 minutes.
#[derive(Default)]
pub struct Throttle {
    failures: Mutex<HashMap<String, VecDeque<i64>>>,
}

impl Throttle {
    fn with<T>(&self, f: impl FnOnce(&mut HashMap<String, VecDeque<i64>>) -> T) -> T {
        let mut map = match self.failures.lock() {
            Ok(m) => m,
            Err(poisoned) => poisoned.into_inner(),
        };
        f(&mut map)
    }

    /// Starts a login attempt for `email`. Refused (false) when 5 attempts have failed
    /// within the window, until the oldest of them is 15 minutes old. Otherwise the attempt
    /// is counted as a failure straight away, so parallel guesses cannot slip past the
    /// limit; `clear` forgets them all when the attempt succeeds.
    pub fn try_begin(&self, email: &str, now: i64) -> bool {
        self.with(|map| {
            if map.len() > 10_000 {
                map.retain(|_, l| l.back().is_some_and(|&t| t > now - THROTTLE_WINDOW_MS));
            }
            let list = map.entry(email.to_string()).or_default();
            while list.front().is_some_and(|&t| t <= now - THROTTLE_WINDOW_MS) {
                list.pop_front();
            }
            if list.len() >= THROTTLE_MAX_FAILURES {
                return false;
            }
            list.push_back(now);
            true
        })
    }

    pub fn clear(&self, email: &str) {
        self.with(|map| map.remove(email));
    }
}

// ---------------------------------------------------------------- handlers

#[derive(Deserialize)]
pub struct LoginBody {
    email: String,
    password: String,
}

pub async fn login(
    State(st): State<Shared>,
    ApiJson(body): ApiJson<LoginBody>,
) -> Result<Response, ApiError> {
    let email = normalize_email(&body.email);
    let now = st.clock.now();
    if !st.throttle.try_begin(&email, now) {
        return Err(ApiError::TooManyAttempts);
    }
    let member = blocking(&st, {
        let email = email.clone();
        move |s| s.member_by_email(&email)
    })
    .await?;
    // The hash work is done whether or not the account exists, so timing reveals nothing.
    let phc = member
        .as_ref()
        .map_or_else(|| st.dummy_hash.clone(), |m| m.password_hash.clone());
    let password = body.password;
    let verified = hashing(&st, move || {
        password.chars().count() <= MAX_PASSWORD_CHARS && verify_password(&password, &phc)
    })
    .await?;
    let member = match member {
        Some(m) if verified && !access_expired(&m, now) => m,
        _ => return Err(ApiError::BadCredentials),
    };
    st.throttle.clear(&email);
    let cookie = start_session(&st, member.id).await?;
    let body = json!({ "member": MemberView::of(&member, &member) });
    Ok(([(SET_COOKIE, cookie)], Json(body)).into_response())
}

pub async fn logout(State(st): State<Shared>, who: SignedIn) -> Result<Response, ApiError> {
    blocking(&st, move |s| s.delete_session(&who.token_hash)).await?;
    let cookie = clearing_cookie(st.config.secure_cookies())?;
    Ok(([(SET_COOKIE, cookie)], Json(json!({}))).into_response())
}

pub async fn me(who: SignedIn) -> Json<serde_json::Value> {
    Json(json!({ "member": MemberView::of(&who.member, &who.member) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_32_random_bytes_and_stored_as_sha256() {
        let a = new_token().unwrap();
        let b = new_token().unwrap();
        assert_ne!(a, b);
        assert_eq!(URL_SAFE_NO_PAD.decode(&a).unwrap().len(), 32);
        assert_eq!(token_hash(&a).len(), 64);
        assert_eq!(
            token_hash("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn passwords_are_argon2id_with_a_fresh_salt() {
        let a = hash_password("correct horse battery").unwrap();
        let b = hash_password("correct horse battery").unwrap();
        assert!(a.starts_with("$argon2id$"));
        assert_ne!(a, b);
        assert!(verify_password("correct horse battery", &a));
        assert!(!verify_password("wrong horse battery", &a));
        assert!(!verify_password("anything", "not a hash"));
    }

    #[test]
    fn new_passwords_need_twelve_characters() {
        assert!(check_new_password("elevenchars").is_err());
        assert!(check_new_password("twelve chars").is_ok());
        assert!(check_new_password("ééééééééééé").is_err());
    }

    #[test]
    fn the_session_cookie_is_read_from_any_cookie_header() {
        let mut h = HeaderMap::new();
        h.append(
            COOKIE,
            HeaderValue::from_static("a=1; qoop_session=tok; b=2"),
        );
        assert_eq!(cookie_token(&h).as_deref(), Some("tok"));
        let mut h = HeaderMap::new();
        h.append(COOKIE, HeaderValue::from_static("qoop_session="));
        assert_eq!(cookie_token(&h), None);
    }

    #[test]
    fn the_throttle_refuses_the_sixth_attempt_until_the_window_passes() {
        let t = Throttle::default();
        for i in 0..5 {
            assert!(t.try_begin("a@x", i));
        }
        assert!(!t.try_begin("a@x", 10));
        assert!(t.try_begin("b@x", 10));
        assert!(!t.try_begin("a@x", THROTTLE_WINDOW_MS - 1));
        assert!(t.try_begin("a@x", THROTTLE_WINDOW_MS + 1));
        t.clear("a@x");
        for i in 0..5 {
            assert!(t.try_begin("a@x", THROTTLE_WINDOW_MS + 2 + i));
        }
    }
}
