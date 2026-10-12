//! The rules of the bridge, without Tauri types: the script that defines
//! `window.qoopDesktop`, who may call the commands behind it, and what a `send` request may
//! contain.

use qoop_claude_driver::{RunRequest, Secret};
use serde::Deserialize;
use url::Url;

use crate::address::same_origin;

/// The label of the one window that shows the server's UI.
pub const MAIN_WINDOW: &str = "main";

const BRIDGE_JS: &str = include_str!("bridge.js");

/// The initialization script for the main window: defines `window.qoopDesktop` on pages of
/// `origin`, in the top frame.
pub fn script(origin: &str, version: &str, key: &str) -> String {
    let literal = |s: &str| {
        // A JSON string is a JavaScript string literal; `<` is escaped for good measure.
        serde_json::to_string(s)
            .expect("a string always serialises")
            .replace('<', "\\u003c")
    };
    BRIDGE_JS
        .replace("__QOOP_ORIGIN__;", &format!("{};", literal(origin)))
        .replace("__QOOP_VERSION__;", &format!("{};", literal(version)))
        .replace("__QOOP_KEY__;", &format!("{};", literal(key)))
}

/// Defence in depth behind Tauri's own access control: a bridge command runs only when it
/// was called from the main window, while that window shows a page of the configured
/// origin, with the key that only the bridge script holds.
pub fn check_caller(
    window: &str,
    page: Option<&Url>,
    origin: Option<&str>,
    key: &str,
    expected_key: &str,
) -> Result<(), String> {
    let allowed = window == MAIN_WINDOW
        && matches!((page, origin), (Some(page), Some(origin)) if same_origin(page, origin))
        && constant_time_eq(key.as_bytes(), expected_key.as_bytes());
    if allowed {
        Ok(())
    } else {
        Err("Not allowed.".into())
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len()
        && !a.is_empty()
        && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The `request` argument of `qoopDesktop.claude.send`. Deliberately not `Debug`: it holds
/// the access token.
#[derive(Deserialize)]
pub struct SendRequest {
    pub id: String,
    pub prompt: String,
    pub system: String,
    #[serde(default)]
    pub resume: Option<String>,
    pub tools: Tools,
}

#[derive(Deserialize)]
pub struct Tools {
    pub url: String,
    pub token: String,
}

const MAX_PROMPT_BYTES: usize = 400_000;
const MAX_SYSTEM_BYTES: usize = 60_000;

/// Checks a request before anything is started. The error is a plain sentence for the
/// sidebar; it never quotes the request.
pub fn validate(request: SendRequest, origin: &str) -> Result<(String, RunRequest), String> {
    const MALFORMED: &str = "The desktop app received a request it cannot run.";
    let SendRequest {
        id,
        prompt,
        system,
        resume,
        tools,
    } = request;
    if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) {
        return Err(MALFORMED.into());
    }
    if prompt.trim().is_empty() {
        return Err("There is no message to send.".into());
    }
    if prompt.len() > MAX_PROMPT_BYTES {
        return Err("The message is too long to send.".into());
    }
    // The system text becomes a command-line argument: bounded, and no NUL.
    if system.len() > MAX_SYSTEM_BYTES || system.contains('\0') {
        return Err(MALFORMED.into());
    }
    if let Some(session) = &resume {
        let plausible = session.starts_with(|c: char| c.is_ascii_alphanumeric())
            && session.len() <= 128
            && session
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'));
        if !plausible {
            return Err(MALFORMED.into());
        }
    }
    // Claude Code is only ever pointed at the tool endpoint of the server this window shows.
    if tools.url != format!("{origin}/mcp") {
        return Err(MALFORMED.into());
    }
    let token_ok = !tools.token.is_empty()
        && tools.token.len() <= 512
        && tools.token.chars().all(|c| c.is_ascii_graphic());
    if !token_ok {
        return Err(MALFORMED.into());
    }
    Ok((
        id,
        RunRequest {
            prompt,
            system,
            resume,
            tools_url: tools.url,
            tools_token: Secret::new(tools.token),
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: &str = "https://qoop.example.org";
    const KEY: &str = "0123456789abcdef0123456789abcdef";

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn only_the_main_window_on_the_configured_origin_with_the_key_may_call() {
        let page = url("https://qoop.example.org/board/1");
        assert_eq!(
            check_caller("main", Some(&page), Some(ORIGIN), KEY, KEY),
            Ok(())
        );

        let refused = Err("Not allowed.".to_owned());
        // Another window (the local first-run screen).
        assert_eq!(
            check_caller("setup", Some(&page), Some(ORIGIN), KEY, KEY),
            refused
        );
        assert_eq!(
            check_caller(
                "setup",
                Some(&url("tauri://localhost/index.html")),
                Some(ORIGIN),
                KEY,
                KEY
            ),
            refused
        );
        // The main window showing anything else.
        for other in [
            "https://evil.example/",
            "http://qoop.example.org/",
            "https://qoop.example.org:8443/",
            "https://qoop.example.org.evil.example/",
            "https://qoop.example.org@evil.example/",
            "about:blank",
            "data:text/html,x",
            "blob:https://qoop.example.org/1",
            "tauri://localhost/",
        ] {
            assert_eq!(
                check_caller("main", Some(&url(other)), Some(ORIGIN), KEY, KEY),
                refused,
                "{other}"
            );
        }
        // No page, or no server configured.
        assert_eq!(check_caller("main", None, Some(ORIGIN), KEY, KEY), refused);
        assert_eq!(check_caller("main", Some(&page), None, KEY, KEY), refused);
        // The wrong key, or none.
        assert_eq!(
            check_caller("main", Some(&page), Some(ORIGIN), "", KEY),
            refused
        );
        assert_eq!(
            check_caller("main", Some(&page), Some(ORIGIN), "", ""),
            refused
        );
        assert_eq!(
            check_caller("main", Some(&page), Some(ORIGIN), &KEY[1..], KEY),
            refused
        );
        assert_eq!(
            check_caller(
                "main",
                Some(&page),
                Some(ORIGIN),
                "0123456789abcdef0123456789abcdeX",
                KEY
            ),
            refused
        );
    }

    #[test]
    fn the_script_carries_its_values_as_string_literals() {
        let js = script("http://localhost:8787", "0.1.0", KEY);
        assert!(js.contains(r#"var ORIGIN = "http://localhost:8787";"#));
        assert!(js.contains(r#"var VERSION = "0.1.0";"#));
        assert!(js.contains(&format!(r#"var KEY = "{KEY}";"#)));
        assert!(!js.contains("__QOOP_ORIGIN__;") && !js.contains("__QOOP_KEY__;"));
        // The frame and origin checks are there.
        assert!(js.contains("if (window.top !== window) return;"));
        assert!(js.contains("if (window.location.origin !== ORIGIN) return;"));
        // Nothing can break out of the literal.
        let js = script("https://x\"</script><script>alert(1)//", "1\n2", "k\\");
        let lt = "\\u003c";
        assert!(js.contains(&format!(
            r#"var ORIGIN = "https://x\"{lt}/script>{lt}script>alert(1)//";"#
        )));
        assert!(!js.contains("</script>"));
        assert!(js.contains(r#"var VERSION = "1\n2";"#));
        assert!(js.contains(r#"var KEY = "k\\";"#));
    }

    fn request() -> SendRequest {
        SendRequest {
            id: "turn-1".into(),
            prompt: "What is here?".into(),
            system: "You are in Qoop.".into(),
            resume: None,
            tools: Tools {
                url: format!("{ORIGIN}/mcp"),
                token: "qoop_pat_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG".into(),
            },
        }
    }

    fn rejects(change: impl FnOnce(&mut SendRequest)) -> String {
        let mut r = request();
        change(&mut r);
        let token = r.tools.token.clone();
        let prompt = r.prompt.clone();
        let message = validate(r, ORIGIN)
            .map(|_| ())
            .expect_err("the request was accepted");
        assert!(
            token.is_empty() || !message.contains(&token),
            "the error quotes the token"
        );
        assert!(prompt.trim().is_empty() || !message.contains(&prompt));
        message
    }

    #[test]
    fn a_good_request_passes_through_unchanged() {
        let mut r = request();
        r.resume = Some("0b9f6c1e-1111-4222-8333-444455556666".into());
        let (id, run) = validate(r, ORIGIN).ok().unwrap();
        assert_eq!(id, "turn-1");
        assert_eq!(run.prompt, "What is here?");
        assert_eq!(run.system, "You are in Qoop.");
        assert_eq!(
            run.resume.as_deref(),
            Some("0b9f6c1e-1111-4222-8333-444455556666")
        );
        assert_eq!(run.tools_url, "https://qoop.example.org/mcp");
        assert_eq!(
            run.tools_token.expose(),
            "qoop_pat_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"
        );
    }

    #[test]
    fn the_request_json_of_the_web_ui_deserialises() {
        let r: SendRequest = serde_json::from_str(
            r#"{"id":"a","prompt":"p","system":"s","tools":{"url":"https://qoop.example.org/mcp","token":"t"}}"#,
        )
        .unwrap();
        assert!(r.resume.is_none());
        assert!(validate(r, ORIGIN).is_ok());
    }

    #[test]
    fn the_tool_endpoint_must_be_the_configured_servers() {
        for other in [
            "https://evil.example/mcp",
            "http://qoop.example.org/mcp",
            "https://qoop.example.org/mcp/",
            "https://qoop.example.org/mcp?x=1",
            "https://qoop.example.org/other",
            "https://qoop.example.org@evil.example/mcp",
            "https://qoop.example.org",
            "",
        ] {
            rejects(|r| r.tools.url = other.into());
        }
    }

    #[test]
    fn malformed_requests_are_refused() {
        rejects(|r| r.id = String::new());
        rejects(|r| r.id = "x".repeat(129));
        rejects(|r| r.id = "a\nb".into());
        assert_eq!(
            rejects(|r| r.prompt = "  \n ".into()),
            "There is no message to send."
        );
        assert_eq!(
            rejects(|r| r.prompt = "x".repeat(MAX_PROMPT_BYTES + 1)),
            "The message is too long to send."
        );
        rejects(|r| r.system = "x".repeat(MAX_SYSTEM_BYTES + 1));
        rejects(|r| r.system = "a\0b".into());
        // A session id is letters, digits, `-` and `_`: starting with a letter or digit: it can
        // never look like an option.
        for bad in [
            "",
            "--dangerously-skip-permissions",
            "a b",
            "a=b",
            "../x",
            "é",
        ] {
            rejects(|r| r.resume = Some(bad.into()));
        }
        rejects(|r| r.resume = Some("x".repeat(129)));
        for bad in ["", "has space", "line\nbreak", "ünï"] {
            rejects(|r| r.tools.token = bad.into());
        }
        rejects(|r| r.tools.token = "x".repeat(513));
    }
}
