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
    /// A Member who started more AI turns than a minute allows.
    #[error("too many AI turns")]
    TooManyTurns,
    /// The OpenRouter path is off: the server has no `QOOP_SECRET_KEY`.
    #[error("AI not configured")]
    AiNotConfigured,
    /// The Member has no OpenRouter key, or the stored one can no longer be read; the
    /// value is the sentence shown.
    #[error("no OpenRouter key")]
    NoKey(&'static str),
    /// The Member has not chosen a model.
    #[error("no model")]
    NoModel,
    /// The upstream model list could not be fetched.
    #[error("upstream failed")]
    UpstreamFailed,
    /// A Source lookup for an id the registry does not know; the value is the sentence.
    #[error("{0}")]
    LookupNotFound(&'static str),
    /// A registry that did not answer, or answered nonsense; the value is the sentence.
    #[error("{0}")]
    LookupFailed(&'static str),
    /// A Member who asked for more Source lookups than a minute allows.
    #[error("too many lookups")]
    TooManyLookups,
    /// A Local Workspace moved to a Team server: nothing may be changed (M18).
    #[error("moved")]
    Moved,
    /// A Workspace file may come only into an empty Team Workspace (M18).
    #[error("not empty")]
    NotEmpty,
    /// What was sent is not a Workspace file (M18).
    #[error("not a workspace file")]
    NotAWorkspaceFile,
    /// A Workspace file made by a newer version (M18).
    #[error("newer version")]
    NewerVersion,
    /// A request body over its limit; the value is the sentence.
    #[error("{0}")]
    TooLarge(String),
    /// A PDF a Source names whose bytes this Workspace does not have (M19): a Workspace file
    /// exported without its PDFs, or a hash nothing was ever stored under.
    #[error("file missing")]
    FileMissing,
    /// A stored PDF whose text has not been stored yet (M19).
    #[error("no text")]
    NoText,
    /// What was sent as a PDF does not start as one (M19).
    #[error("not a PDF")]
    NotAPdf,
    /// A `Range` that lies outside the file; the value is the file's size.
    #[error("range not satisfiable")]
    RangeNotSatisfiable(u64),
    /// arXiv did not give the PDF asked for; the value is the sentence (M19).
    #[error("{0}")]
    FetchFailed(&'static str),
    /// A Member who asked for more PDFs from arXiv than a minute allows (M19).
    #[error("too many fetches")]
    TooManyFetches,
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
                "This request did not come from the Infall app.".into(),
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
            TooManyTurns => (
                StatusCode::TOO_MANY_REQUESTS,
                "too_many_requests",
                "Too many AI turns in a minute. Try again in a moment.".into(),
            ),
            AiNotConfigured => (
                StatusCode::SERVICE_UNAVAILABLE,
                "ai_not_configured",
                "OpenRouter keys are not set up on this server.".into(),
            ),
            NoKey(m) => (StatusCode::CONFLICT, "no_key", (*m).into()),
            NoModel => (
                StatusCode::CONFLICT,
                "no_model",
                "Choose a model first.".into(),
            ),
            UpstreamFailed => (
                StatusCode::BAD_GATEWAY,
                "upstream_failed",
                "The list of models could not be fetched from OpenRouter. Try again later.".into(),
            ),
            LookupNotFound(m) => (StatusCode::NOT_FOUND, "not_found", (*m).into()),
            LookupFailed(m) => (StatusCode::BAD_GATEWAY, "lookup_failed", (*m).into()),
            TooManyLookups => (
                StatusCode::TOO_MANY_REQUESTS,
                "too_many_requests",
                "Too many lookups in a minute. Try again in a moment.".into(),
            ),
            Moved => (
                StatusCode::FORBIDDEN,
                "moved",
                crate::local::MOVED_SENTENCE.into(),
            ),
            NotEmpty => (
                StatusCode::CONFLICT,
                "not_empty",
                "A Workspace file can be brought only into an empty Workspace, and this one already has work in it.".into(),
            ),
            NotAWorkspaceFile => (
                StatusCode::BAD_REQUEST,
                "not_a_workspace_file",
                crate::local::PortError::NotAWorkspaceFile.to_string(),
            ),
            NewerVersion => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "newer_version",
                crate::local::PortError::NewerVersion.to_string(),
            ),
            TooLarge(m) => (StatusCode::PAYLOAD_TOO_LARGE, "too_large", m.clone()),
            FileMissing => (
                StatusCode::NOT_FOUND,
                "file_missing",
                "This PDF is not stored in this Workspace. It may have been left out of the Workspace file it came from; attach it again.".into(),
            ),
            NoText => (
                StatusCode::NOT_FOUND,
                "no_text",
                "The text of this PDF has not been stored yet.".into(),
            ),
            NotAPdf => (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "not_a_pdf",
                "This file is not a PDF. Only PDF files can be attached to a Source.".into(),
            ),
            RangeNotSatisfiable(_) => (
                StatusCode::RANGE_NOT_SATISFIABLE,
                "range_not_satisfiable",
                "The range asked for lies outside this file.".into(),
            ),
            FetchFailed(m) => (StatusCode::BAD_GATEWAY, "fetch_failed", (*m).into()),
            TooManyFetches => (
                StatusCode::TOO_MANY_REQUESTS,
                "too_many_requests",
                "Too many PDFs fetched from arXiv in a minute. Try again in a moment.".into(),
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
        let range = match &self {
            ApiError::RangeNotSatisfiable(size) => Some(*size),
            _ => None,
        };
        let detail = match self {
            ApiError::Rejected(v) | ApiError::Undecided(v) | ApiError::BadDecision(v) => v,
            _ => Value::Null,
        };
        let body = json!({ "error": { "code": code, "message": message, "detail": detail } });
        let mut res = (status, Json(body)).into_response();
        if let Some(size) = range
            && let Ok(v) = axum::http::HeaderValue::from_str(&format!("bytes */{size}"))
        {
            res.headers_mut()
                .insert(axum::http::header::CONTENT_RANGE, v);
        }
        res
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
            "The request body is too large.".to_string()
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
