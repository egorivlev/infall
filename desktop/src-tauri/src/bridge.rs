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

/// The label of the Runner settings window (local UI).
pub const SETTINGS_WINDOW: &str = "runner-settings";
/// The label of an approval window is this followed by the ticket of the question it asks.
pub const APPROVAL_PREFIX: &str = "runner-approval-";

/// The label of the approval window for `ticket`.
pub fn approval_window(ticket: u64) -> String {
    format!("{APPROVAL_PREFIX}{ticket}")
}

/// Is `page` the app's own bundled file `file`? The app's files are served from
/// `tauri://localhost` (macOS, Linux) or `http(s)://tauri.localhost` (Windows); nothing a
/// server sends can have such an address.
pub fn is_local_page(page: &Url, file: &str) -> bool {
    let bundled = match page.scheme() {
        "tauri" => page.host_str() == Some("localhost"),
        "http" | "https" => page.host_str() == Some("tauri.localhost"),
        _ => false,
    };
    bundled
        && page.port().is_none()
        && page.username().is_empty()
        && page.password().is_none()
        && page.path().strip_prefix('/') == Some(file)
}

/// The settings commands run only when called from the Runner settings window while it
/// shows the app's own settings page. (Tauri's capability for that window is the first
/// line of defence; this is the second.)
pub fn check_settings_caller(window: &str, page: Option<&Url>) -> Result<(), String> {
    if window == SETTINGS_WINDOW && page.is_some_and(|p| is_local_page(p, "runner.html")) {
        Ok(())
    } else {
        Err("Not allowed.".into())
    }
}

/// The approval commands run only when called from an approval window while it shows the
/// app's own approval page. Returns the ticket that window was opened for: the question it
/// may answer is taken from its label, never from what the call says.
pub fn check_approval_caller(window: &str, page: Option<&Url>) -> Result<u64, String> {
    let ticket = window
        .strip_prefix(APPROVAL_PREFIX)
        .and_then(|t| t.parse::<u64>().ok().filter(|n| n.to_string() == t));
    match ticket {
        Some(ticket) if page.is_some_and(|p| is_local_page(p, "approval.html")) => Ok(ticket),
        _ => Err("Not allowed.".into()),
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
    fn only_the_apps_own_windows_may_call_the_local_commands() {
        let refused = Err::<(), String>("Not allowed.".to_owned());
        let no_ticket = Err::<u64, String>("Not allowed.".to_owned());
        let approval = url("tauri://localhost/approval.html");
        let settings = url("tauri://localhost/runner.html");

        assert_eq!(
            check_approval_caller("runner-approval-7", Some(&approval)),
            Ok(7)
        );
        assert_eq!(
            check_approval_caller(&approval_window(u64::MAX), Some(&approval)),
            Ok(u64::MAX)
        );
        // Windows serves the app's files from http://tauri.localhost.
        assert_eq!(
            check_approval_caller(
                "runner-approval-7",
                Some(&url("http://tauri.localhost/approval.html"))
            ),
            Ok(7)
        );
        assert_eq!(
            check_settings_caller("runner-settings", Some(&settings)),
            Ok(())
        );

        // The main window — the server's pages — whatever it shows.
        for page in [
            "https://qoop.example.org/board/1",
            "https://qoop.example.org/approval.html",
            "tauri://localhost/approval.html",
            "tauri://localhost/runner.html",
        ] {
            assert_eq!(
                check_approval_caller("main", Some(&url(page))),
                no_ticket,
                "{page}"
            );
            assert_eq!(
                check_settings_caller("main", Some(&url(page))),
                refused,
                "{page}"
            );
        }
        // The other local windows: each may only call its own commands.
        assert_eq!(check_approval_caller("setup", Some(&approval)), no_ticket);
        assert_eq!(
            check_approval_caller("runner-settings", Some(&approval)),
            no_ticket
        );
        assert_eq!(check_settings_caller("setup", Some(&settings)), refused);
        assert_eq!(
            check_settings_caller("runner-approval-7", Some(&settings)),
            refused
        );
        assert_eq!(
            check_settings_caller("runner-settings-2", Some(&settings)),
            refused
        );
        // A label that is not exactly the prefix and a ticket number.
        for label in [
            "runner-approval-",
            "runner-approval",
            "runner-approval-x",
            "runner-approval-07",
            "runner-approval-+7",
            "runner-approval--7",
            "runner-approval-7 ",
            "runner-approval-7-8",
            "runner-approval-18446744073709551616",
            "xrunner-approval-7",
            "",
        ] {
            assert_eq!(
                check_approval_caller(label, Some(&approval)),
                no_ticket,
                "{label:?}"
            );
        }
        // The right window showing anything but the app's own page for it.
        for page in [
            "https://qoop.example.org/approval.html",
            "https://evil.example/approval.html",
            "http://localhost/approval.html",
            "http://tauri.localhost.evil.example/approval.html",
            "https://tauri.localhost:8443/approval.html",
            "https://user@tauri.localhost/approval.html",
            "tauri://evil/approval.html",
            "tauri://localhost/index.html",
            "tauri://localhost/runner.html",
            "tauri://localhost/x/approval.html",
            "tauri://localhost//approval.html",
            "tauri://localhost/",
            "file:///approval.html",
            "about:blank",
            "data:text/html,approval.html",
            "blob:tauri://localhost/approval.html",
        ] {
            assert_eq!(
                check_approval_caller("runner-approval-7", Some(&url(page))),
                no_ticket,
                "{page}"
            );
        }
        for page in [
            "https://qoop.example.org/runner.html",
            "tauri://localhost/approval.html",
            "tauri://localhost/index.html",
            "about:blank",
        ] {
            assert_eq!(
                check_settings_caller("runner-settings", Some(&url(page))),
                refused,
                "{page}"
            );
        }
        assert_eq!(check_approval_caller("runner-approval-7", None), no_ticket);
        assert_eq!(check_settings_caller("runner-settings", None), refused);
        // A query or fragment does not make it another page.
        assert_eq!(
            check_approval_caller(
                "runner-approval-7",
                Some(&url("tauri://localhost/approval.html?x=1#y"))
            ),
            Ok(7)
        );
    }

    #[test]
    fn the_script_offers_the_runner_and_nothing_that_approves() {
        let js = script("http://localhost:8787", "0.1.0", KEY);
        for command in [
            "runner_status",
            "runner_configure",
            "runner_run",
            "runner_cancel",
        ] {
            assert!(js.contains(&format!("'{command}'")), "{command}");
        }
        // The commands of the app's own windows are not even named in what a page gets.
        for local in ["approval_", "runner_settings", "setup_"] {
            assert!(!js.contains(local), "{local}");
        }
        assert!(js.contains("runner: runner"));
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
