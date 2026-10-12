#![allow(dead_code)]

pub mod openrouter;

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use qoop_server::config::Config;
use qoop_server::store::{MemoryStore, Store};
use qoop_server::{Clock, build_app_with, create_admin};
use serde_json::{Value, json};
use tower::ServiceExt;

pub const ORIGIN: &str = "http://localhost:8787";
pub const PASSWORD: &str = "a long enough password";
pub const START: i64 = 1_800_000_000_000;

pub struct TestApp {
    pub router: Router,
    pub clock: Clock,
    pub store: Arc<dyn Store>,
    pub web: tempfile::TempDir,
}

pub struct Res {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Value,
    pub text: String,
}

impl Res {
    /// `qoop_session=<token>` from the response's Set-Cookie, ready for a Cookie header.
    pub fn cookie(&self) -> String {
        let set = self
            .headers
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|v| v.to_str().unwrap().to_string())
            .find(|v| v.starts_with("qoop_session="))
            .expect("a session cookie");
        set.split(';').next().unwrap().to_string()
    }

    pub fn set_cookie(&self) -> Option<String> {
        self.headers
            .get(header::SET_COOKIE)
            .map(|v| v.to_str().unwrap().to_string())
    }

    pub fn code(&self) -> &str {
        self.body["error"]["code"].as_str().unwrap_or("")
    }
}

pub fn web_dir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("index.html"),
        "<!doctype html><title>Qoop UI</title>",
    )
    .unwrap();
    std::fs::create_dir(dir.path().join("assets")).unwrap();
    std::fs::write(dir.path().join("assets/app.js"), "console.log('qoop')").unwrap();
    dir
}

impl TestApp {
    pub fn new() -> TestApp {
        Self::with_store(Arc::new(MemoryStore::new()))
    }

    pub fn with_store(store: Arc<dyn Store>) -> TestApp {
        Self::with_config(store, |_| {})
    }

    pub fn with_config(store: Arc<dyn Store>, tweak: impl FnOnce(&mut Config)) -> TestApp {
        let web = web_dir();
        let mut config = Config::for_tests(web.path());
        tweak(&mut config);
        let clock = Clock::manual(START);
        let (router, _shutdown) = build_app_with(config, store.clone(), clock.clone()).unwrap();
        TestApp {
            router,
            clock,
            store,
            web,
        }
    }

    pub async fn send(&self, req: Request<Body>) -> Res {
        let res = self.router.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8_lossy(&bytes).to_string();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Res {
            status,
            headers,
            body,
            text,
        }
    }

    pub async fn get(&self, path: &str, cookie: Option<&str>) -> Res {
        let mut b = Request::builder().method(Method::GET).uri(path);
        if let Some(c) = cookie {
            b = b.header(header::COOKIE, c);
        }
        self.send(b.body(Body::empty()).unwrap()).await
    }

    /// A write the way the UI sends it: Origin and X-Qoop-Request set.
    pub async fn write(
        &self,
        method: Method,
        path: &str,
        cookie: Option<&str>,
        body: Value,
    ) -> Res {
        let mut b = Request::builder()
            .method(method)
            .uri(path)
            .header(header::ORIGIN, ORIGIN)
            .header("x-qoop-request", "1")
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(c) = cookie {
            b = b.header(header::COOKIE, c);
        }
        self.send(b.body(Body::from(body.to_string())).unwrap())
            .await
    }

    pub async fn post(&self, path: &str, cookie: Option<&str>, body: Value) -> Res {
        self.write(Method::POST, path, cookie, body).await
    }

    pub async fn put(&self, path: &str, cookie: Option<&str>, body: Value) -> Res {
        self.write(Method::PUT, path, cookie, body).await
    }

    pub async fn delete(&self, path: &str, cookie: Option<&str>) -> Res {
        self.write(Method::DELETE, path, cookie, Value::Null).await
    }

    pub async fn login(&self, email: &str, password: &str) -> Res {
        self.post(
            "/api/auth/login",
            None,
            json!({ "email": email, "password": password }),
        )
        .await
    }

    /// Creates an Admin and signs in; returns the session cookie.
    pub async fn admin(&self) -> String {
        create_admin(
            &*self.store,
            "admin@example.org",
            "Ada Admin",
            PASSWORD,
            START,
        )
        .unwrap();
        let res = self.login("admin@example.org", PASSWORD).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        res.cookie()
    }

    /// Invites `email` as `role` and returns the invite token.
    pub async fn invite(
        &self,
        admin: &str,
        email: &str,
        role: &str,
        access_until: Option<i64>,
    ) -> String {
        let mut body = json!({ "email": email, "role": role });
        if let Some(t) = access_until {
            body["access_until"] = json!(t);
        }
        let res = self.post("/api/invites", Some(admin), body).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        let url = res.body["url"].as_str().unwrap();
        url.rsplit('/').next().unwrap().to_string()
    }

    /// Invites and accepts; returns the new person's cookie.
    pub async fn join(
        &self,
        admin: &str,
        email: &str,
        role: &str,
        access_until: Option<i64>,
    ) -> String {
        let token = self.invite(admin, email, role, access_until).await;
        let res = self
            .post(
                "/api/auth/accept-invite",
                None,
                json!({ "token": token, "name": email.split('@').next().unwrap(), "password": PASSWORD }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        res.cookie()
    }

    pub async fn main_branch(&self, cookie: &str) -> String {
        let res = self.get("/api/branches", Some(cookie)).await;
        res.body["branches"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["name"] == "main")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string()
    }
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn create_card(id: &str, title: &str) -> Value {
    json!({ "Create": { "entity": id, "kind": "Card", "fields": { "title": { "Text": title } } } })
}

pub fn set_title(id: &str, title: &str) -> Value {
    json!({ "Set": { "entity": id, "field": "title", "value": { "Text": title } } })
}

// ---------------------------------------------------------------- the tool endpoint

/// What a `tools/call` gave back.
pub struct ToolOut {
    pub is_error: bool,
    /// The one `text` content item.
    pub text: String,
    /// That text parsed as JSON (`Null` when it is a sentence).
    pub json: Value,
}

impl TestApp {
    /// A request to `/mcp` the way a non-browser client sends it: no Origin, no cookie.
    pub async fn mcp(&self, bearer: Option<&str>, body: Value) -> Res {
        self.mcp_raw(bearer, body.to_string()).await
    }

    pub async fn mcp_raw(&self, bearer: Option<&str>, body: String) -> Res {
        let mut b = Request::builder()
            .method(Method::POST)
            .uri("/mcp")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ACCEPT, "application/json, text/event-stream");
        if let Some(t) = bearer {
            b = b.header(header::AUTHORIZATION, format!("Bearer {t}"));
        }
        self.send(b.body(Body::from(body)).unwrap()).await
    }

    /// A JSON-RPC request; returns the whole HTTP response.
    pub async fn rpc(&self, bearer: &str, method: &str, params: Value) -> Res {
        self.mcp(
            Some(bearer),
            json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }),
        )
        .await
    }

    /// Creates an access token for the signed-in Member; returns its secret.
    pub async fn access_token(&self, cookie: &str, name: &str) -> String {
        let res = self
            .post("/api/tokens", Some(cookie), json!({ "name": name }))
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        res.body["secret"].as_str().unwrap().to_string()
    }

    /// Calls a tool; the call itself must succeed as JSON-RPC.
    pub async fn tool(&self, bearer: &str, name: &str, arguments: Value) -> ToolOut {
        let res = self
            .rpc(
                bearer,
                "tools/call",
                json!({ "name": name, "arguments": arguments }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        let result = &res.body["result"];
        assert!(result.is_object(), "no result: {}", res.text);
        let content = result["content"].as_array().expect("content");
        assert_eq!(content.len(), 1, "{}", res.text);
        assert_eq!(content[0]["type"], "text");
        let text = content[0]["text"].as_str().unwrap().to_string();
        ToolOut {
            is_error: result["isError"].as_bool().expect("isError"),
            json: serde_json::from_str(&text).unwrap_or(Value::Null),
            text,
        }
    }

    /// Calls a tool that must succeed; returns its JSON.
    pub async fn tool_ok(&self, bearer: &str, name: &str, arguments: Value) -> Value {
        let out = self.tool(bearer, name, arguments).await;
        assert!(!out.is_error, "{name} failed: {}", out.text);
        out.json
    }

    /// Calls a tool that must fail with a sentence; returns the sentence.
    pub async fn tool_err(&self, bearer: &str, name: &str, arguments: Value) -> String {
        let out = self.tool(bearer, name, arguments).await;
        assert!(out.is_error, "{name} should have failed: {}", out.text);
        out.text
    }

    /// Posts ops to a Branch; they must be accepted.
    pub async fn ops(&self, cookie: &str, branch: &str, ops: Value) -> Res {
        let res = self
            .post(
                &format!("/api/branches/{branch}/ops"),
                Some(cookie),
                json!({ "ops": ops }),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text);
        res
    }

    /// The stored Workspace, byte for byte.
    pub fn workspace_bytes(&self) -> String {
        serde_json::to_string(&self.store.load_workspace().unwrap().unwrap()).unwrap()
    }
}

pub fn create(id: &str, kind: &str, fields: Value) -> Value {
    json!({ "Create": { "entity": id, "kind": kind, "fields": fields } })
}

pub fn delete_op(id: &str) -> Value {
    json!({ "Delete": { "entity": id } })
}
