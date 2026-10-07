//! The API error type and its JSON body (contract §4).

use axum::Json;
use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{FromRequest, FromRequestParts, Request};
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::store::StoreError;

/// Everything an API call can fail with.
#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("{0}")]
    BadRequest(String),
    #[error("not signed in")]
    NotSignedIn,
    #[error("bad credentials")]
    BadCredentials,
    #[error("{0}")]
    Forbidden(&'static str),
    #[error("forbidden origin")]
    ForbiddenOrigin,
    #[error("not found")]
    NotFound,
    /// The core refused an operation; the value is the core error as JSON.
    #[error("rejected")]
    Rejected(Value),
    #[error("email taken")]
    EmailTaken,
    /// A Checkpoint or Branch name that is already in use.
    #[error("name taken")]
    NameTaken,
    /// A Merge whose plan no longer matches the Branches.
    #[error("stale")]
    Stale,
    /// Conflicts of a Merge without a Decision; the value is their keys as JSON.
    #[error("undecided")]
    Undecided(Value),
    /// A Decision that cannot be used; the value is its Conflict key as JSON.
    #[error("bad decision")]
    BadDecision(Value),
    #[error("not parent and child")]
    NotParentAndChild,
    #[error("invite expired")]
    InviteExpired,
    #[error("too many attempts")]
    TooManyAttempts,
    /// Accepting a Suggestion whose Card is no longer live on its Branch.
    #[error("suggestion stale")]
    SuggestionStale,
    /// A Suggestion that is not in the state the action needs.
    #[error("already decided")]
    AlreadyDecided,
    /// An access token used more often than the tool endpoint allows.
    #[error("too many requests")]
    TooManyRequests,
    /// Logged, never shown.
    #[error("internal: {0}")]
    Internal(String),
}

impl ApiError {
    pub fn internal(cause: impl std::fmt::Display) -> ApiError {
        ApiError::Internal(cause.to_string())
    }

    fn parts(&self) -> (StatusCode, &'static str, String) {
        use ApiError::*;
        match self {
            BadRequest(m) => (StatusCode::BAD_REQUEST, "bad_request", m.clone()),
            NotSignedIn => (
                StatusCode::UNAUTHORIZED,
                "not_signed_in",
                "You are not signed in.".into(),
            ),
            BadCredentials => (
                StatusCode::UNAUTHORIZED,
                "bad_credentials",
                "That email and password do not match an account.".into(),
            ),
            Forbidden(m) => (StatusCode::FORBIDDEN, "forbidden", (*m).into()),
            ForbiddenOrigin => (
                StatusCode::FORBIDDEN,
                "forbidden_origin",
                "This request did not come from the Qoop app.".into(),
            ),
            NotFound => (
                StatusCode::NOT_FOUND,
                "not_found",
                "There is nothing here.".into(),
            ),
            Rejected(_) => (
                StatusCode::CONFLICT,
                "rejected",
                "The Board refused this change; nothing was applied.".into(),
            ),
            EmailTaken => (
                StatusCode::CONFLICT,
                "email_taken",
                "An account with that email already exists.".into(),
            ),
            NameTaken => (
                StatusCode::CONFLICT,
                "name_taken",
                "That name is already in use.".into(),
            ),
            Stale => (
                StatusCode::CONFLICT,
                "stale",
                "A Branch has changed since this Merge was planned. Plan it again.".into(),
            ),
            Undecided(_) => (
                StatusCode::BAD_REQUEST,
                "undecided",
                "Every Conflict needs a Decision before the Merge can be applied.".into(),
            ),
            BadDecision(_) => (
                StatusCode::BAD_REQUEST,
                "bad_decision",
                "A Decision is repeated, matches no Conflict, or gives a hand-written value where none is allowed.".into(),
            ),
            NotParentAndChild => (
                StatusCode::BAD_REQUEST,
                "not_parent_and_child",
                "A Merge is only possible between a Branch and its direct parent.".into(),
            ),
            InviteExpired => (
                StatusCode::GONE,
                "invite_expired",
                "This invite has expired or has already been used.".into(),
            ),
            TooManyAttempts => (
                StatusCode::TOO_MANY_REQUESTS,
                "too_many_attempts",
                "Too many failed sign-in attempts. Try again in 15 minutes.".into(),
            ),
            SuggestionStale => (
                StatusCode::CONFLICT,
                "stale",
                "The Card this Suggestion was for is no longer on this Branch.".into(),
            ),
            AlreadyDecided => (
                StatusCode::CONFLICT,
                "already_decided",
                "This Suggestion has already been decided.".into(),
            ),
            TooManyRequests => (
                StatusCode::TOO_MANY_REQUESTS,
                "too_many_requests",
                "Too many requests with this access token. Try again in a minute.".into(),
            ),
            Internal(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "Something went wrong on the server.".into(),
            ),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        if let ApiError::Internal(cause) = &self {
            tracing::error!(%cause, "internal error");
        }
        let (status, code, message) = self.parts();
        let detail = match self {
            ApiError::Rejected(v) | ApiError::Undecided(v) | ApiError::BadDecision(v) => v,
            _ => Value::Null,
        };
        let body = json!({ "error": { "code": code, "message": message, "detail": detail } });
        (status, Json(body)).into_response()
    }
}

impl From<StoreError> for ApiError {
    fn from(e: StoreError) -> ApiError {
        match e {
            StoreError::EmailTaken => ApiError::EmailTaken,
            StoreError::InviteGone => ApiError::InviteExpired,
            StoreError::Backend(cause) => ApiError::Internal(cause),
        }
    }
}

/// `axum::Json`, but a body that is malformed, of the wrong type or too large is a
/// `400 bad_request` in the contract's shape.
pub struct ApiJson<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for ApiJson<T> {
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, ApiError> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(v)) => Ok(ApiJson(v)),
            Err(rejection) => Err(json_rejection(rejection)),
        }
    }
}

fn json_rejection(r: JsonRejection) -> ApiError {
    let message = match &r {
        JsonRejection::JsonDataError(e) => format!("The request body has the wrong shape: {e}"),
        JsonRejection::JsonSyntaxError(_) => "The request body is not valid JSON.".to_string(),
        JsonRejection::MissingJsonContentType(_) => {
            "Send the request body as application/json.".to_string()
        }
        _ if r.status() == StatusCode::PAYLOAD_TOO_LARGE => {
            "The request body is larger than 1 MB.".to_string()
        }
        _ => "The request body could not be read.".to_string(),
    };
    ApiError::BadRequest(message)
}

/// `axum::extract::Query`, with failures as `400 bad_request`.
pub struct ApiQuery<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequestParts<S> for ApiQuery<T> {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, ApiError> {
        axum::extract::Query::<T>::from_request_parts(parts, state)
            .await
            .map(|q| ApiQuery(q.0))
            .map_err(|e: QueryRejection| {
                ApiError::BadRequest(format!("The query string is invalid: {}", e.body_text()))
            })
    }
}
