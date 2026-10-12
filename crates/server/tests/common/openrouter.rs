//! A stand-in for OpenRouter: a local HTTP server that plays scripted OpenAI-style
//! answers and records what it was asked. Plus what a test needs to run an AI turn.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::Response;
use http_body_util::BodyExt;
use qoop_server::secret::SecretKey;
use qoop_server::store::{MemoryStore, Store};
use serde_json::{Value, json};

use super::{Res, TestApp};

/// A key the way OpenRouter hands them out; no test may ever see it come back.
pub const KEY: &str = "sk-or-v1-7f3a9c2e5b8d4f6a1c0e9b7d5f3a2c4e6b8d0f1a3c5e7b9d-TAIL";
pub const MODEL: &str = "fake/model-1";

/// One thing the fake does while answering.
#[derive(Clone)]
pub enum Step {
    Send(Vec<u8>),
    Wait(u64),
    /// Sends these bytes every so many milliseconds, for ever.
    Drip(Vec<u8>, u64),
    /// Keeps the response open and silent for ever.
    Hang,
}

/// A scripted answer.
#[derive(Clone)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    /// Milliseconds before the response starts.
    pub delay: u64,
    pub steps: Vec<Step>,
}

/// A request the fake received.
#[derive(Clone)]
pub struct Seen {
    pub method: String,
    pub path: String,
    pub headers: HeaderMap,
    pub body: Value,
}

impl Seen {
    pub fn header(&self, name: &str) -> &str {
        self.headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
    }

    pub fn messages(&self) -> &Vec<Value> {
        self.body["messages"].as_array().expect("messages")
    }
}

#[derive(Default)]
struct Script {
    replies: Mutex<VecDeque<Reply>>,
    models: Mutex<Option<Reply>>,
    seen: Mutex<Vec<Seen>>,
    /// Responses whose stream was dropped before it had played out.
    cancelled: AtomicUsize,
}

pub struct Upstream {
    /// The base URL to configure, with a path prefix like the real one.
    pub url: String,
    script: Arc<Script>,
}

/// Counts a response stream that is dropped before its last step.
struct Playing {
    script: Arc<Script>,
    steps: VecDeque<Step>,
    finished: AtomicBool,
}

impl Drop for Playing {
    fn drop(&mut self) {
        if !self.finished.load(Ordering::SeqCst) {
            self.script.cancelled.fetch_add(1, Ordering::SeqCst);
        }
    }
}

// ---------------------------------------------------------------- building answers

pub fn sse(events: &[Value]) -> Vec<u8> {
    let mut out = String::new();
    for e in events {
        out.push_str(&format!("data: {e}\n\n"));
    }
    out.push_str("data: [DONE]\n\n");
    out.into_bytes()
}

pub fn chunk(delta: Value, finish: Option<&str>) -> Value {
    json!({
        "id": "gen-1",
        "object": "chat.completion.chunk",
        "model": "fake/answered-by",
        "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }],
    })
}

pub fn text_events(pieces: &[&str]) -> Vec<Value> {
    let mut events = vec![chunk(json!({ "role": "assistant", "content": "" }), None)];
    events.extend(pieces.iter().map(|p| chunk(json!({ "content": p }), None)));
    events.push(chunk(json!({}), Some("stop")));
    events
}

/// The events of an answer that calls tools: `(id, name, arguments as JSON text)`. The
/// arguments of each call arrive in two pieces.
pub fn tool_events(calls: &[(&str, &str, &str)]) -> Vec<Value> {
    let mut events = vec![chunk(json!({ "role": "assistant", "content": null }), None)];
    for (i, (id, name, _)) in calls.iter().enumerate() {
        events.push(chunk(
            json!({ "tool_calls": [{ "index": i, "id": id, "type": "function", "function": { "name": name, "arguments": "" } }] }),
            None,
        ));
    }
    for (i, (_, _, arguments)) in calls.iter().enumerate() {
        let cut = (0..=arguments.len() / 2)
            .rev()
            .find(|at| arguments.is_char_boundary(*at))
            .unwrap_or(0);
        for piece in [&arguments[..cut], &arguments[cut..]] {
            events.push(chunk(
                json!({ "tool_calls": [{ "index": i, "function": { "arguments": piece } }] }),
                None,
            ));
        }
    }
    events.push(chunk(json!({}), Some("tool_calls")));
    events
}

impl Reply {
    pub fn steps(steps: Vec<Step>) -> Reply {
        Reply {
            status: 200,
            headers: vec![("content-type".into(), "text/event-stream".into())],
            delay: 0,
            steps,
        }
    }

    pub fn raw(bytes: impl Into<Vec<u8>>) -> Reply {
        Reply::steps(vec![Step::Send(bytes.into())])
    }

    /// A streamed answer made of these pieces of text.
    pub fn answer(pieces: &[&str]) -> Reply {
        Reply::raw(sse(&text_events(pieces)))
    }

    /// An answer that calls tools.
    pub fn tools(calls: &[(&str, &str, &str)]) -> Reply {
        Reply::raw(sse(&tool_events(calls)))
    }

    /// A failure with a JSON body.
    pub fn status(status: u16, body: &str) -> Reply {
        Reply {
            status,
            headers: vec![("content-type".into(), "application/json".into())],
            delay: 0,
            steps: vec![Step::Send(body.as_bytes().to_vec())],
        }
    }

    pub fn json(body: Value) -> Reply {
        Reply::status(200, &body.to_string())
    }

    pub fn header(mut self, name: &str, value: &str) -> Reply {
        self.headers.push((name.into(), value.into()));
        self
    }

    pub fn after(mut self, ms: u64) -> Reply {
        self.delay = ms;
        self
    }
}

// ---------------------------------------------------------------- the server

async fn play(State(script): State<Arc<Script>>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let bytes = body
        .collect()
        .await
        .map(|b| b.to_bytes())
        .unwrap_or_default();
    let path = parts.uri.path().to_string();
    script.seen.lock().unwrap().push(Seen {
        method: parts.method.to_string(),
        path: path.clone(),
        headers: parts.headers.clone(),
        body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    });
    let reply = if path.ends_with("/models") {
        script.models.lock().unwrap().clone().unwrap_or_else(|| {
            Reply::json(json!({ "data": [
                { "id": MODEL, "name": "Fake model 1", "context_length": 100000, "supported_parameters": ["tools"] },
            ] }))
        })
    } else {
        let next = script.replies.lock().unwrap().pop_front();
        next.unwrap_or_else(|| Reply::answer(&["ok"]))
    };
    if reply.delay > 0 {
        tokio::time::sleep(Duration::from_millis(reply.delay)).await;
    }
    let playing = Playing {
        script: script.clone(),
        steps: reply.steps.into(),
        finished: AtomicBool::new(false),
    };
    let stream = futures_util::stream::unfold(playing, |mut playing| async move {
        loop {
            match playing.steps.front().cloned() {
                None => {
                    playing.finished.store(true, Ordering::SeqCst);
                    return None;
                }
                Some(Step::Send(bytes)) => {
                    playing.steps.pop_front();
                    return Some((Ok::<Bytes, std::io::Error>(Bytes::from(bytes)), playing));
                }
                Some(Step::Wait(ms)) => {
                    playing.steps.pop_front();
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                }
                Some(Step::Drip(bytes, ms)) => {
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                    return Some((Ok(Bytes::from(bytes)), playing));
                }
                Some(Step::Hang) => std::future::pending::<()>().await,
            }
        }
    });
    let mut res = Response::builder().status(StatusCode::from_u16(reply.status).unwrap());
    for (name, value) in &reply.headers {
        res = res.header(name.as_str(), value.as_str());
    }
    res.body(Body::from_stream(stream)).unwrap()
}

impl Upstream {
    /// Starts the fake on a free local port.
    pub async fn start() -> Upstream {
        let script = Arc::new(Script::default());
        let router = Router::new().fallback(play).with_state(script.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Upstream {
            url: format!("http://{addr}/api/v1"),
            script,
        }
    }

    /// Queues the answer to the next chat request. With nothing queued the fake answers
    /// "ok".
    pub fn push(&self, reply: Reply) {
        self.script.replies.lock().unwrap().push_back(reply);
    }

    /// Sets what `GET /models` answers from now on.
    pub fn models(&self, reply: Reply) {
        *self.script.models.lock().unwrap() = Some(reply);
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.script.seen.lock().unwrap().clone()
    }

    /// The chat requests received, in order.
    pub fn chats(&self) -> Vec<Seen> {
        let mut seen = self.seen();
        seen.retain(|s| s.path.ends_with("/chat/completions"));
        seen
    }

    pub fn cancelled(&self) -> usize {
        self.script.cancelled.load(Ordering::SeqCst)
    }

    pub fn unplayed(&self) -> usize {
        self.script.replies.lock().unwrap().len()
    }
}

// ---------------------------------------------------------------- the app under test

/// The events of a chat response.
pub struct Chat {
    pub res: Res,
    pub events: Vec<Value>,
}

impl Chat {
    /// All `delta` text joined.
    pub fn text(&self) -> String {
        self.events
            .iter()
            .filter(|e| e["type"] == "delta")
            .map(|e| e["text"].as_str().unwrap())
            .collect()
    }

    pub fn types(&self) -> Vec<&str> {
        self.events
            .iter()
            .map(|e| e["type"].as_str().unwrap())
            .collect()
    }

    pub fn tools(&self) -> Vec<&str> {
        self.events
            .iter()
            .filter(|e| e["type"] == "tool")
            .map(|e| e["name"].as_str().unwrap())
            .collect()
    }

    pub fn last(&self) -> &Value {
        self.events.last().expect("at least one event")
    }

    /// The message of the `error` event the stream must have ended with — the only one.
    pub fn error(&self) -> &str {
        let errors = self.events.iter().filter(|e| e["type"] == "error").count();
        assert_eq!(errors, 1, "{}", self.res.text);
        assert_eq!(self.last()["type"], "error", "{}", self.res.text);
        assert!(!self.types().contains(&"done"), "{}", self.res.text);
        self.last()["message"].as_str().unwrap()
    }
}

/// Parses an event stream body: every event is exactly one `data: <JSON>` line followed
/// by a blank line.
pub fn events_of(text: &str) -> Vec<Value> {
    let mut events = Vec::new();
    for block in text.split("\n\n").filter(|b| !b.is_empty()) {
        let json = block.strip_prefix("data: ").expect("a data line");
        assert!(!json.contains('\n'), "one line per event: {block:?}");
        events.push(serde_json::from_str(json).expect("event JSON"));
    }
    assert!(text.is_empty() || text.ends_with("\n\n"));
    events
}

impl TestApp {
    /// An app with the OpenRouter path on, talking to `upstream_url`.
    pub fn with_ai(store: Arc<dyn Store>, upstream_url: &str) -> TestApp {
        Self::with_ai_key(store, upstream_url, SecretKey::generate().unwrap())
    }

    pub fn with_ai_key(store: Arc<dyn Store>, upstream_url: &str, secret: SecretKey) -> TestApp {
        let url = upstream_url.to_string();
        TestApp::with_config(store, move |c| {
            c.secret_key = Some(secret);
            c.openrouter_url = url;
        })
    }

    pub fn ai(upstream: &Upstream) -> TestApp {
        Self::with_ai(Arc::new(MemoryStore::new()), &upstream.url)
    }

    /// Gives the signed-in Member a key and a model.
    pub async fn ai_ready(&self, cookie: &str) {
        let res = self
            .put("/api/ai/key", Some(cookie), json!({ "key": KEY }))
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        let res = self
            .put("/api/ai/model", Some(cookie), json!({ "model": MODEL }))
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    }

    /// `POST /api/ai/chat` with any body; the stream is read to its end.
    pub async fn chat_raw(&self, cookie: Option<&str>, body: Value) -> Chat {
        let res = self.post("/api/ai/chat", cookie, body).await;
        let stream = res
            .headers
            .get(header::CONTENT_TYPE)
            .is_some_and(|v| v == "text/event-stream");
        let events = if stream {
            events_of(&res.text)
        } else {
            Vec::new()
        };
        Chat { res, events }
    }

    /// One user message; the turn must start.
    pub async fn chat(&self, cookie: &str, text: &str) -> Chat {
        let chat = self
            .chat_raw(
                Some(cookie),
                json!({ "messages": [{ "role": "user", "content": text }] }),
            )
            .await;
        assert_eq!(chat.res.status, StatusCode::OK, "{}", chat.res.text);
        assert!(!chat.events.is_empty(), "no events");
        chat
    }
}
