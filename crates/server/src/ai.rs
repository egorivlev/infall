//! The OpenRouter path of the AI sidebar (contract §14): a Member's own key, kept sealed,
//! their choice of model, and the list of models. The chat turn itself is in `chat`.
//!
//! The key goes in through `PUT /api/ai/key` and never comes out: no response, error or
//! log line holds it, and it is opened only for the request that needs it.

use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::extract::State;
use qoop_core::MemberId;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::app::{Shared, blocking};
use crate::auth::MemberOrAdmin;
use crate::error::{ApiError, ApiJson};
use crate::secret::SecretKey;
use crate::store::AiKeyRecord;
use crate::tokens::RateLimit;

/// The most AI turns one Member may start within a minute.
pub const TURNS_PER_MINUTE: usize = 20;
/// How long the list of models is kept before it is fetched again.
pub const MODELS_CACHE_MS: i64 = 60 * 60 * 1000;
const MODELS_TIMEOUT: Duration = Duration::from_secs(20);
/// The most bytes of a model list that are read.
const MODELS_MAX_BYTES: usize = 16 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

const KEY_MIN_CHARS: usize = 20;
const KEY_MAX_CHARS: usize = 400;
const MODEL_MAX_CHARS: usize = 120;
const MODEL_NAME_MAX_CHARS: usize = 200;

pub const NO_KEY: &str = "Add an OpenRouter key first.";
pub const UNREADABLE_KEY: &str = "The stored OpenRouter key can no longer be read. Add it again.";

/// What the OpenRouter path shares between requests.
pub struct AiState {
    /// The one client for upstream calls: it follows no redirects and uses no proxy, so
    /// the configured base URL is the only place a request (and the key in it) can go.
    pub http: reqwest::Client,
    /// AI turns per Member.
    pub turns: RateLimit,
    /// The model list and when it was fetched.
    models: tokio::sync::Mutex<Option<(i64, Arc<Vec<AiModel>>)>>,
}

impl AiState {
    pub fn new() -> Result<AiState, String> {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(CONNECT_TIMEOUT)
            .user_agent(concat!("qoop-server/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| format!("cannot set up the HTTP client: {e}"))?;
        Ok(AiState {
            http,
            turns: RateLimit::new(TURNS_PER_MINUTE),
            models: tokio::sync::Mutex::new(None),
        })
    }
}

/// The server's secret key, or `503 ai_not_configured` when the OpenRouter path is off.
pub fn secret_key(st: &Shared) -> Result<&SecretKey, ApiError> {
    st.config
        .secret_key
        .as_ref()
        .ok_or(ApiError::AiNotConfigured)
}

// ---------------------------------------------------------------- status and settings

#[derive(Serialize)]
struct KeyView {
    last4: String,
    added_at: i64,
}

/// `AiStatus`: never the key, only its last four characters.
#[derive(Serialize)]
struct AiStatus {
    enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    key: Option<KeyView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
}

/// The caller's status. A stored key is listed only if this server can still read it, so
/// that "there is a key" always means "a turn can use it".
async fn status_of(st: &Shared, member: MemberId) -> Result<Json<AiStatus>, ApiError> {
    let settings = blocking(st, move |s| s.ai_settings(member)).await?;
    let secret = st.config.secret_key.as_ref();
    let key = match (secret, settings.key) {
        (Some(secret), Some(k)) if secret.open(member, &k.ciphertext, &k.nonce).is_some() => {
            Some(KeyView {
                last4: k.last4,
                added_at: k.added_at,
            })
        }
        _ => None,
    };
    Ok(Json(AiStatus {
        enabled: secret.is_some(),
        key,
        model: settings.model,
    }))
}

pub async fn get_status(
    State(st): State<Shared>,
    MemberOrAdmin(who): MemberOrAdmin,
) -> Result<impl axum::response::IntoResponse, ApiError> {
    status_of(&st, who.id()).await
}

/// 20–400 printable ASCII characters, no spaces. The sentence never repeats the value.
fn check_key(key: &str) -> Result<(), ApiError> {
    let ok = (KEY_MIN_CHARS..=KEY_MAX_CHARS).contains(&key.len())
        && key.bytes().all(|b| (0x21..=0x7e).contains(&b));
    if ok {
        Ok(())
    } else {
        Err(ApiError::BadRequest(format!(
            "An OpenRouter key is {KEY_MIN_CHARS} to {KEY_MAX_CHARS} printable ASCII characters without spaces."
        )))
    }
}

/// 1–120 characters of `[A-Za-z0-9._:/-]`.
fn model_id_ok(model: &str) -> bool {
    (1..=MODEL_MAX_CHARS).contains(&model.len())
        && model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'/' | b'-'))
}

/// `PUT /api/ai/key`. The body is read as plain JSON rather than into a typed struct, so
/// that no parser message can quote a value that was sent in the wrong shape.
pub async fn put_key(
    State(st): State<Shared>,
    MemberOrAdmin(who): MemberOrAdmin,
    ApiJson(body): ApiJson<Value>,
) -> Result<impl axum::response::IntoResponse, ApiError> {
    let secret = secret_key(&st)?;
    let Some(key) = body.get("key").and_then(Value::as_str) else {
        return Err(ApiError::BadRequest(
            "Send the key as { \"key\": \"…\" }.".to_string(),
        ));
    };
    check_key(key)?;
    let member = who.id();
    let sealed = secret.seal(member, key).map_err(ApiError::internal)?;
    let record = AiKeyRecord {
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        // Checked above: ASCII, at least 20 long.
        last4: key[key.len() - 4..].to_string(),
        added_at: st.clock.now(),
    };
    if !blocking(&st, move |s| s.set_ai_key(member, Some(&record))).await? {
        return Err(ApiError::NotSignedIn);
    }
    tracing::info!(member = %member.0, "OpenRouter key stored");
    status_of(&st, member).await
}

pub async fn delete_key(
    State(st): State<Shared>,
    MemberOrAdmin(who): MemberOrAdmin,
) -> Result<impl axum::response::IntoResponse, ApiError> {
    secret_key(&st)?;
    let member = who.id();
    if !blocking(&st, move |s| s.set_ai_key(member, None)).await? {
        return Err(ApiError::NotSignedIn);
    }
    tracing::info!(member = %member.0, "OpenRouter key removed");
    status_of(&st, member).await
}

#[derive(Deserialize)]
pub struct PutModel {
    model: String,
}

pub async fn put_model(
    State(st): State<Shared>,
    MemberOrAdmin(who): MemberOrAdmin,
    ApiJson(body): ApiJson<PutModel>,
) -> Result<impl axum::response::IntoResponse, ApiError> {
    secret_key(&st)?;
    if !model_id_ok(&body.model) {
        return Err(ApiError::BadRequest(format!(
            "A model id is 1 to {MODEL_MAX_CHARS} characters: letters, digits and . _ : / -"
        )));
    }
    let member = who.id();
    if !blocking(&st, move |s| s.set_ai_model(member, &body.model)).await? {
        return Err(ApiError::NotSignedIn);
    }
    status_of(&st, member).await
}

// ---------------------------------------------------------------- models

/// One model a Member can choose.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AiModel {
    id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_length: Option<u64>,
}

/// Reads an upstream model list: `{ data: [{ id, name, context_length?,
/// supported_parameters? }] }`. Entries that do not fit are skipped rather than failing
/// the list; a model that says which parameters it supports is kept only if `tools` is
/// one of them. `None` if there is no `data` array at all.
fn parse_models(body: &Value) -> Option<Vec<AiModel>> {
    let entries = body.get("data")?.as_array()?;
    Some(
        entries
            .iter()
            .filter_map(|m| {
                let id = m.get("id")?.as_str()?;
                if !model_id_ok(id) {
                    return None;
                }
                if let Some(supported) = m.get("supported_parameters").and_then(Value::as_array)
                    && !supported.iter().any(|p| p == "tools")
                {
                    return None;
                }
                let name = match m.get("name").and_then(Value::as_str).map(str::trim) {
                    Some(name) if !name.is_empty() => name
                        .chars()
                        .filter(|c| !c.is_control())
                        .take(MODEL_NAME_MAX_CHARS)
                        .collect(),
                    _ => id.to_string(),
                };
                let context_length = m
                    .get("context_length")
                    .and_then(|n| n.as_u64().or_else(|| n.as_f64().map(|f| f as u64)))
                    .filter(|n| *n > 0);
                Some(AiModel {
                    id: id.to_string(),
                    name,
                    context_length,
                })
            })
            .collect(),
    )
}

/// Fetches `<base>/models`. No key is sent: the list is public and shared by everyone.
/// Any failure is `None`; the cause is logged without the response body.
async fn fetch_models(st: &Shared) -> Option<Vec<AiModel>> {
    let url = format!("{}/models", st.config.openrouter_url);
    let fetch = async {
        let mut res = st
            .ai
            .http
            .get(&url)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|e| crate::chat::Fault::of_transport(&e).name())?;
        if !res.status().is_success() {
            tracing::warn!(
                status = res.status().as_u16(),
                "model list refused upstream"
            );
            return Err("status");
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = res.chunk().await.map_err(|_| "body")? {
            if bytes.len() + chunk.len() > MODELS_MAX_BYTES {
                return Err("too large");
            }
            bytes.extend_from_slice(&chunk);
        }
        let body: Value = serde_json::from_slice(&bytes).map_err(|_| "not JSON")?;
        parse_models(&body).ok_or("unexpected shape")
    };
    match tokio::time::timeout(MODELS_TIMEOUT, fetch).await {
        Ok(Ok(models)) => Some(models),
        Ok(Err(why)) => {
            tracing::warn!(why, "model list could not be fetched");
            None
        }
        Err(_) => {
            tracing::warn!(why = "timeout", "model list could not be fetched");
            None
        }
    }
}

/// `GET /api/ai/models`.
pub async fn get_models(
    State(st): State<Shared>,
    MemberOrAdmin(_): MemberOrAdmin,
) -> Result<Json<Value>, ApiError> {
    secret_key(&st)?;
    // Held across the fetch, so a burst of requests makes one upstream call.
    let mut cache = st.ai.models.lock().await;
    let now = st.clock.now();
    let models = match &*cache {
        Some((at, models)) if now - at < MODELS_CACHE_MS && now >= *at => models.clone(),
        _ => {
            let models = Arc::new(fetch_models(&st).await.ok_or(ApiError::UpstreamFailed)?);
            *cache = Some((now, models.clone()));
            models
        }
    };
    Ok(Json(json!({ "models": &*models })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_20_to_400_printable_ascii_without_spaces() {
        assert!(check_key(&"k".repeat(20)).is_ok());
        assert!(check_key(&"k".repeat(400)).is_ok());
        assert!(check_key("sk-or-v1-0123456789abcdef~!{}").is_ok());
        for bad in [
            "k".repeat(19),
            "k".repeat(401),
            format!("{} {}", "k".repeat(10), "k".repeat(10)),
            format!("{}\n", "k".repeat(20)),
            format!("{}é", "k".repeat(20)),
            format!("{}\u{7f}", "k".repeat(20)),
            String::new(),
        ] {
            let ApiError::BadRequest(message) = check_key(&bad).unwrap_err() else {
                panic!("not a bad request");
            };
            assert!(!message.contains("kkkk"), "the sentence repeats the value");
        }
    }

    #[test]
    fn model_ids_are_1_to_120_characters_of_the_allowed_set() {
        for good in [
            "anthropic/claude-sonnet-4.5",
            "openai/gpt-5:free",
            "a",
            &"m".repeat(120),
            "x_y/z-1.2:beta",
        ] {
            assert!(model_id_ok(good), "{good}");
        }
        for bad in ["", &"m".repeat(121), "a b", "a\"b", "é", "a\nb", "a?b"] {
            assert!(!model_id_ok(bad), "{bad:?}");
        }
    }

    #[test]
    fn the_model_list_tolerates_drift_and_keeps_tool_callers() {
        let body = json!({
            "data": [
                { "id": "a/tools", "name": "With tools", "context_length": 200000,
                  "supported_parameters": ["temperature", "tools"], "pricing": { "prompt": "0" } },
                { "id": "a/no-tools", "name": "Without", "supported_parameters": ["temperature"] },
                { "id": "a/unsaid", "name": "  Does not say  " },
                { "id": "a/odd", "name": 7, "context_length": "many", "supported_parameters": "tools" },
                { "id": "a/float", "name": "", "context_length": 8192.0 },
                { "id": "has space", "name": "Skipped" },
                { "name": "No id" },
                { "id": 5 },
                "not an object",
                null
            ],
            "extra": true
        });
        let got = serde_json::to_value(parse_models(&body).unwrap()).unwrap();
        assert_eq!(
            got,
            json!([
                { "id": "a/tools", "name": "With tools", "context_length": 200000 },
                { "id": "a/unsaid", "name": "Does not say" },
                { "id": "a/odd", "name": "a/odd" },
                { "id": "a/float", "name": "a/float", "context_length": 8192 },
            ])
        );
        assert_eq!(parse_models(&json!({ "data": [] })).unwrap(), vec![]);
        for bad in [
            json!({}),
            json!({ "data": {} }),
            json!([]),
            json!("x"),
            json!({ "models": [] }),
        ] {
            assert!(parse_models(&bad).is_none(), "{bad}");
        }
    }
}
