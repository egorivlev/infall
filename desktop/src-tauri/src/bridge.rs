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

/// Whether the bridge script takes `window.print()` over for the page. The macOS webview
/// (WKWebView) ignores `window.print()`, and Tauri's own replacement calls a command remote
/// pages are not allowed; the app prints the page itself (`print_page`). Elsewhere the
/// webview's own `window.print()` opens the system's print dialog.
pub const OWN_PRINT: bool = cfg!(target_os = "macos");

/// The initialization script for the main window: defines `window.qoopDesktop` on pages of
/// `origin`, in the top frame.
pub fn script(origin: &str, version: &str, key: &str) -> String {
    script_with(origin, version, key, OWN_PRINT)
}

fn script_with(origin: &str, version: &str, key: &str, own_print: bool) -> String {
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
        .replace(
            "__QOOP_OWN_PRINT__;",
            if own_print { "true;" } else { "false;" },
        )
        .replace(
            "__QOOP_MAX_BINARY_BYTES__;",
            &format!("{};", crate::transfer::MAX_BINARY_SAVE_BYTES),
        )
        .replace(
            "__QOOP_MAX_MOVE_BYTES__;",
            &format!("{};", crate::transfer::MAX_MOVE_BYTES),
        )
        .replace(
            "__QOOP_MAX_PDF_BYTES__;",
            &format!("{};", crate::files::MAX_PDF_BYTES),
        )
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
    bundled && page.port().is_none() && page.username().is_empty() && page.password().is_none() && {
        // Tauri opens the app's `index.html` at the root address, with no file name
        // (and, for `tauri://localhost`, no path at all).
        let path = page.path();
        path.strip_prefix('/') == Some(file) || (file == "index.html" && matches!(path, "" | "/"))
    }
}

/// The label of the start screen's window (local UI).
pub const SETUP_WINDOW: &str = "setup";

/// The start screen's commands run only when called from its window while it shows the
/// app's own start page. (Tauri's capability for that window is the first line of defence;
/// this is the second.)
pub fn check_setup_caller(window: &str, page: Option<&Url>) -> Result<(), String> {
    if window == SETUP_WINDOW && page.is_some_and(|p| is_local_page(p, "index.html")) {
        Ok(())
    } else {
        Err("Not allowed.".into())
    }
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

// ---- Undo and Redo in the Edit menu (docs/specs/undo.md, decision 11; desktop.md, M15) ---

/// One of the Edit menu's two items.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Undo,
    Redo,
}

impl Step {
    /// The item's plain title, and the word its titles start with.
    pub fn verb(self) -> &'static str {
        match self {
            Step::Undo => "Undo",
            Step::Redo => "Redo",
        }
    }
}

/// The longest title the menu shows for a step, in characters, "…" included.
pub const MAX_STEP_TITLE: usize = 80;

/// What the page's `window.__infallUndo.state()` last said, as the menu may show it: the
/// title of the step Undo would take back and of the one Redo would do again. `None` is
/// "nothing named": nothing to do, or a text field being edited (the page does not say which).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UndoSteps {
    pub undo: Option<String>,
    pub redo: Option<String>,
}

impl UndoSteps {
    /// From the labels the bridge script sent (each a string or null).
    pub fn from_page(undo: Option<&str>, redo: Option<&str>) -> UndoSteps {
        UndoSteps {
            undo: undo.and_then(|label| step_title(Step::Undo, label)),
            redo: redo.and_then(|label| step_title(Step::Redo, label)),
        }
    }

    pub fn get(&self, step: Step) -> Option<&str> {
        match step {
            Step::Undo => self.undo.as_deref(),
            Step::Redo => self.redo.as_deref(),
        }
    }
}

/// The menu title for a step the page names. The page's labels are already titles ("Undo
/// Move 3 Cards"); a label without the verb gets it put in front, so whatever a page says,
/// the item starts with what it does. Made one short line of plain text: no control
/// characters, nothing that turns the direction of the text around, runs of space as one.
/// `None` when nothing is left.
pub fn step_title(step: Step, label: &str) -> Option<String> {
    let plain: String = label
        .chars()
        .filter(|&c| !is_direction_control(c))
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let text = plain.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return None;
    }
    let verb = step.verb();
    let title = match text.strip_prefix(verb) {
        Some(rest) if rest.is_empty() || rest.starts_with(' ') => text,
        _ => format!("{verb} {text}"),
    };
    if title.chars().count() <= MAX_STEP_TITLE {
        return Some(title);
    }
    let kept: String = title.chars().take(MAX_STEP_TITLE - 1).collect();
    Some(format!("{}…", kept.trim_end()))
}

fn is_direction_control(c: char) -> bool {
    matches!(
        c,
        '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
    )
}

/// A title as the menu library takes it: there `&` marks a mnemonic, `&&` is one `&`.
pub fn menu_text(title: &str) -> String {
    title.replace('&', "&&")
}

/// What one of the two items is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditItem {
    /// The app's own item, with this title, calling the page's own `undo()` or `redo()`.
    Step(String),
    /// The system's own item: the text undo of whatever field has focus, in any window, as
    /// before M15 (macOS, Windows).
    System,
    /// The app's own item, plainly "Undo" or "Redo", greyed out: where there is no system
    /// item (Linux).
    Off,
}

/// The rule for each item: the page's step only while the main window has focus and its page
/// names one; otherwise the system's own item, so text fields — in the page, on the start
/// screen, in the Runner settings — keep their own undo; and where there is none, nothing.
pub fn edit_item(title: Option<&str>, main_focused: bool, has_system_item: bool) -> EditItem {
    match title {
        Some(title) if main_focused => EditItem::Step(title.to_owned()),
        _ if has_system_item => EditItem::System,
        _ => EditItem::Off,
    }
}

/// What the app's own item runs in the main window's page: the page's own `undo()` or
/// `redo()` while its state still names a step; otherwise (a field was entered after the menu
/// was last told) the web view's text undo, which is what the system's item would have done.
pub fn page_step_script(step: Step) -> String {
    const SCRIPT: &str = "(function () { try { var u = window.__infallUndo; \
var s = u && typeof u.state === 'function' ? u.state() : null; \
if (s && typeof s.STEP === 'string' && s.STEP !== '' && typeof u.STEP === 'function') u.STEP(); \
else document.execCommand('STEP'); } catch (e) {} })();";
    SCRIPT.replace(
        "STEP",
        match step {
            Step::Undo => "undo",
            Step::Redo => "redo",
        },
    )
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

        // The start screen.
        let start = url("tauri://localhost/index.html");
        assert_eq!(check_setup_caller("setup", Some(&start)), Ok(()));
        // What the window really shows: Tauri opens `index.html` at the root address.
        for root in [
            "tauri://localhost",
            "tauri://localhost/",
            "http://tauri.localhost/",
        ] {
            assert_eq!(
                check_setup_caller("setup", Some(&url(root))),
                Ok(()),
                "{root}"
            );
        }
        // Only the start page has that shorthand.
        assert!(
            check_settings_caller("runner-settings", Some(&url("tauri://localhost/"))).is_err()
        );
        assert_eq!(
            check_setup_caller("setup", Some(&url("http://tauri.localhost/index.html"))),
            Ok(())
        );
        for page in [
            "https://qoop.example.org/index.html",
            "http://127.0.0.1:53124/index.html",
            "tauri://localhost/runner.html",
            "tauri://localhost/approval.html",
            "about:blank",
        ] {
            assert_eq!(
                check_setup_caller("setup", Some(&url(page))),
                refused,
                "{page}"
            );
        }
        for window in ["main", "runner-settings", "runner-approval-7", "setup-2"] {
            assert_eq!(
                check_setup_caller(window, Some(&start)),
                refused,
                "{window}"
            );
        }
        assert_eq!(check_setup_caller("setup", None), refused);
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
            "runner_start",
            "runner_cancel",
        ] {
            assert!(js.contains(&format!("'{command}'")), "{command}");
        }
        // A Run in another language goes only through `start`, a method an app from before
        // M19b lacks; `run` refuses one rather than run it as Python, and sends no names.
        assert!(js.contains("start: function (request, onEvent)"));
        assert!(js.contains("stream('runner_start', { request: sent }"));
        assert!(js.contains("if (namesLanguage(request)) {"));
        assert!(js.contains("stream('runner_run', { request: runRequest(request) }"));
        let run_request = js
            .split("function runRequest(request) {")
            .nth(1)
            .and_then(|rest| rest.split("\n    };").next())
            .unwrap();
        assert!(!run_request.contains("lang") && !run_request.contains("env"));
        // The commands of the app's own windows are not even named in what a page gets.
        for local in [
            "approval_",
            "runner_settings",
            "setup_",
            "start_view",
            "workspace_",
        ] {
            assert!(!js.contains(local), "{local}");
        }
        assert!(js.contains("runner: runner"));
        // Leaving the Workspace is offered, like the menu item.
        assert!(js.contains("'switch_workspace'"));
        assert!(js.contains("switchWorkspace: switchWorkspace"));
        // Saving a file (M13, Contract D) and printing.
        assert!(js.contains("'save_file'"));
        assert!(js.contains("saveFile: saveFile"));
        assert!(js.contains("'print_page'"));
    }

    #[test]
    fn printing_is_taken_over_only_where_the_webview_cannot() {
        let own = script_with("http://localhost:8787", "0.1.0", KEY, true);
        let native = script_with("http://localhost:8787", "0.1.0", KEY, false);
        assert!(own.contains("var OWN_PRINT = true;"));
        assert!(native.contains("var OWN_PRINT = false;"));
        assert!(!own.contains("__QOOP_OWN_PRINT__;"));
        assert_eq!(
            script("http://localhost:8787", "0.1.0", KEY).contains("var OWN_PRINT = true;"),
            cfg!(target_os = "macos")
        );
    }

    #[test]
    fn the_script_carries_its_values_as_string_literals() {
        let js = script("http://localhost:8787", "0.1.0", KEY);
        assert!(js.contains(r#"var ORIGIN = "http://localhost:8787";"#));
        assert!(js.contains(r#"var VERSION = "0.1.0";"#));
        assert!(js.contains(&format!(r#"var KEY = "{KEY}";"#)));
        assert!(!js.contains("__QOOP_ORIGIN__;") && !js.contains("__QOOP_KEY__;"));
        // The limit the page is told is the app's own.
        assert!(js.contains(&format!(
            "var MAX_SAVE_BYTES = {};",
            crate::portable::MAX_SAVE_BYTES
        )));
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

    #[test]
    fn the_script_tells_the_app_what_undo_and_redo_would_do_and_nothing_more() {
        let js = script("http://localhost:8787", "0.1.0", KEY);
        assert!(js.contains("'undo_state'"));
        // It reads the page's own object, watches it, and posts only the two labels.
        assert!(js.contains("'__infallUndo'"));
        assert!(js.contains("source.subscribe(queueUndo)"));
        assert!(js.contains("call('undo_state', { undo: undo, redo: redo })"));
        // The page gets nothing new for it: `qoopDesktop`'s members are those of M13 and
        // M18's binary save and move (see `the_script_offers_moves_and_binary_saves`).
        assert!(js.contains(
            "version: VERSION,\n      claude: claude,\n      runner: runner,\n      \
             switchWorkspace: switchWorkspace,\n      saveFile: saveFile,\n      \
             saveBinaryFile: saveBinaryFile,\n      moveHandover: moveHandover,\n      \
             moveFile: moveFile,\n      moveDone: moveDone,\n      pickFolder: pickFolder,\n      \
             readFileIn: readFileIn,\n      openExternally: openExternally\n    }"
        ));
    }

    #[test]
    fn the_script_offers_pdfs_from_a_picked_folder_and_the_system_viewer() {
        let js = script("http://localhost:8787", "0.9.0", KEY);
        for command in ["pick_folder", "folder_file_chunk", "open_external_finish"] {
            assert!(js.contains(&format!("'{command}'")), "{command}");
        }
        // The page is told the app's own limit; no placeholder is left.
        assert!(js.contains(&format!(
            "var MAX_PDF_BYTES = {};",
            crate::files::MAX_PDF_BYTES
        )));
        assert!(!js.contains("__QOOP_MAX_PDF_BYTES__;"));
        // A picked folder reaches the page as a token and a name, nothing else.
        assert!(js.contains("return { token: picked.token, name: picked.name };"));
        // The bytes for the viewer go the way a binary save's do, and only a PDF is sent.
        assert!(js.contains("sendBytes(bytes, 'open_external_finish', { suggestedName: name })"));
        assert!(js.contains("var magic = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-"));
        // Reading names the token and the path the page gave, and the offset; never a folder.
        assert!(js.contains("{ token: String(token == null ? '' : token), path: String("));
    }

    #[test]
    fn the_script_offers_moves_and_binary_saves() {
        let js = script("http://localhost:8787", "0.1.0", KEY);
        for command in [
            "move_handover",
            "move_file_chunk",
            "move_done",
            "save_binary_begin",
            "save_binary_chunk",
            "save_binary_finish",
        ] {
            assert!(js.contains(&format!("'{command}'")), "{command}");
        }
        // The limits the page is told are the app's own; no placeholder is left.
        assert!(js.contains(&format!(
            "var MAX_BINARY_BYTES = {};",
            crate::transfer::MAX_BINARY_SAVE_BYTES
        )));
        assert!(js.contains(&format!(
            "var MAX_MOVE_BYTES = {};",
            crate::transfer::MAX_MOVE_BYTES
        )));
        assert!(
            !js.contains("__QOOP_MAX_BINARY_BYTES__;") && !js.contains("__QOOP_MAX_MOVE_BYTES__;")
        );
        // Pieces of 3 MB of bytes: their text stays under what one piece may carry.
        assert!(js.contains("var SAVE_CHUNK_BYTES = 3145728;"));
        assert!((3_145_728usize).div_ceil(3) * 4 <= crate::transfer::MAX_SAVE_CHUNK_TEXT);
        // Moving starts nothing in the start screen's commands.
        assert!(!js.contains("workspace_move"));
    }

    #[test]
    fn a_move_is_handed_only_to_the_main_windows_page_of_its_server() {
        // `move_handover`, `move_file_chunk` and `move_done` pass `check_caller` first, with
        // the origin the bridge was granted to; the registry then answers only about a move
        // pending to that same origin (workspaces.rs, `a_pending_move_is_kept_and_told_to_its_
        // server_only`). So: another window, another server in the main window, or the
        // granted origin's page without the key are all refused before the registry is read.
        let server = "https://team.example.org";
        let page = url("https://team.example.org/");
        assert!(check_caller("main", Some(&page), Some(server), KEY, KEY).is_ok());
        for window in ["setup", "runner-settings", "runner-approval-1"] {
            assert!(check_caller(window, Some(&page), Some(server), KEY, KEY).is_err());
        }
        for other in [
            "https://evil.example/",
            "https://team.example.org.evil.example/",
            "http://team.example.org/",
            "http://127.0.0.1:24680/",
            "tauri://localhost/index.html",
        ] {
            assert!(
                check_caller("main", Some(&url(other)), Some(server), KEY, KEY).is_err(),
                "{other}"
            );
        }
        assert!(check_caller("main", Some(&page), Some(server), "", KEY).is_err());
    }

    #[test]
    fn the_undo_state_is_taken_only_from_the_main_windows_page() {
        // `undo_state` is checked like every bridge command: the main window, on the open
        // Workspace's origin, with the key. Never the app's own windows.
        let page = url("https://qoop.example.org/board/1");
        assert!(check_caller("main", Some(&page), Some(ORIGIN), KEY, KEY).is_ok());
        for window in [
            "setup",
            "runner-settings",
            "runner-approval-7",
            "main-2",
            "",
        ] {
            assert!(
                check_caller(window, Some(&page), Some(ORIGIN), KEY, KEY).is_err(),
                "{window}"
            );
        }
        for local in [
            "tauri://localhost/index.html",
            "tauri://localhost/approval.html",
            "http://tauri.localhost/runner.html",
        ] {
            assert!(check_caller("main", Some(&url(local)), Some(ORIGIN), KEY, KEY).is_err());
        }
        // Another server's page in the main window, or the Workspace's page without the key.
        assert!(
            check_caller(
                "main",
                Some(&url("https://evil.example/")),
                Some(ORIGIN),
                KEY,
                KEY
            )
            .is_err()
        );
        assert!(check_caller("main", Some(&page), Some(ORIGIN), "", KEY).is_err());
    }

    #[test]
    fn a_step_is_titled_with_its_verb_first() {
        let title = |step, label| step_title(step, label);
        // The page's labels are titles already.
        assert_eq!(
            title(Step::Undo, "Undo Move 3 Cards").as_deref(),
            Some("Undo Move 3 Cards")
        );
        assert_eq!(
            title(Step::Redo, "Redo Delete Card Axions").as_deref(),
            Some("Redo Delete Card Axions")
        );
        assert_eq!(title(Step::Undo, "Undo").as_deref(), Some("Undo"));
        // A bare label gets the verb.
        assert_eq!(
            title(Step::Undo, "Move 3 Cards").as_deref(),
            Some("Undo Move 3 Cards")
        );
        assert_eq!(
            title(Step::Redo, "Import BibTeX").as_deref(),
            Some("Redo Import BibTeX")
        );
        // The item always starts with what it does, whatever the page says.
        assert_eq!(
            title(Step::Undo, "Redo Move").as_deref(),
            Some("Undo Redo Move")
        );
        assert_eq!(
            title(Step::Redo, "Undo Move").as_deref(),
            Some("Redo Undo Move")
        );
        assert_eq!(title(Step::Undo, "Undone").as_deref(), Some("Undo Undone"));
        assert_eq!(
            title(Step::Undo, "undo it").as_deref(),
            Some("Undo undo it")
        );
        // Any language.
        assert_eq!(
            title(Step::Undo, "Undo Переименовать карточку «Аксионы»").as_deref(),
            Some("Undo Переименовать карточку «Аксионы»")
        );
        assert_eq!(
            title(Step::Undo, "Undo 移动 3 张卡片").as_deref(),
            Some("Undo 移动 3 张卡片")
        );
    }

    #[test]
    fn a_label_becomes_one_short_line_of_plain_text() {
        fn title(label: &str) -> Option<String> {
            step_title(Step::Undo, label)
        }
        assert_eq!(
            title("  Undo\tMove\n\n3   Cards  ").as_deref(),
            Some("Undo Move 3 Cards")
        );
        assert_eq!(
            title("Undo Move\u{0}\u{7}\u{1b}[31m Card").as_deref(),
            Some("Undo Move [31m Card")
        );
        // Nothing may turn the text around to make the item read as something else.
        assert_eq!(
            title("Undo \u{202E}tiuQ\u{202C} Card").as_deref(),
            Some("Undo tiuQ Card")
        );
        assert_eq!(
            title("\u{2067}Undo\u{2069} x\u{200F}\u{061C}").as_deref(),
            Some("Undo x")
        );
        // Joiners that scripts need are kept.
        assert_eq!(
            title("Undo می\u{200C}خواهم").as_deref(),
            Some("Undo می\u{200C}خواهم")
        );
        // Nothing left: no step named.
        for empty in ["", "   ", "\n\t", "\u{202E}\u{202C}", "\u{0}"] {
            assert_eq!(title(empty), None, "{empty:?}");
        }
        // Long labels are cut, at a character, and say so.
        let long = title(&format!("Undo Rename Card {}", "é".repeat(200))).unwrap();
        assert_eq!(long.chars().count(), MAX_STEP_TITLE);
        assert!(long.starts_with("Undo Rename Card éé") && long.ends_with('…'));
        let spaced = title(&format!("Undo {} tail", "a".repeat(MAX_STEP_TITLE - 7))).unwrap();
        assert!(spaced.ends_with("a…"), "{spaced}");
        let exact = format!("Undo {}", "b".repeat(MAX_STEP_TITLE - 5));
        assert_eq!(title(&exact).as_deref(), Some(exact.as_str()));
    }

    #[test]
    fn the_state_from_the_page_is_two_titles_or_none() {
        assert_eq!(UndoSteps::from_page(None, None), UndoSteps::default());
        let steps = UndoSteps::from_page(Some("Undo Move 3 Cards"), None);
        assert_eq!(steps.get(Step::Undo), Some("Undo Move 3 Cards"));
        assert_eq!(steps.get(Step::Redo), None);
        let steps = UndoSteps::from_page(Some(" "), Some("Redo Add Card"));
        assert_eq!(steps.get(Step::Undo), None);
        assert_eq!(steps.get(Step::Redo), Some("Redo Add Card"));
        // Each label gets its own verb.
        let steps = UndoSteps::from_page(Some("Add Card"), Some("Add Card"));
        assert_eq!(steps.undo.as_deref(), Some("Undo Add Card"));
        assert_eq!(steps.redo.as_deref(), Some("Redo Add Card"));
    }

    #[test]
    fn an_ampersand_in_a_title_is_shown_as_one() {
        assert_eq!(menu_text("Undo Rename R&D"), "Undo Rename R&&D");
        assert_eq!(menu_text("Undo A && B"), "Undo A &&&& B");
        assert_eq!(menu_text("Undo Move"), "Undo Move");
    }

    #[test]
    fn the_menu_names_the_step_only_for_the_focused_main_window() {
        let named = Some("Undo Move 3 Cards");
        let step = EditItem::Step("Undo Move 3 Cards".to_owned());
        // macOS and Windows: the page's step, else the system's text undo.
        assert_eq!(edit_item(named, true, true), step);
        assert_eq!(edit_item(named, false, true), EditItem::System);
        assert_eq!(edit_item(None, true, true), EditItem::System);
        assert_eq!(edit_item(None, false, true), EditItem::System);
        // Linux: the page's step, else greyed out.
        assert_eq!(edit_item(named, true, false), step);
        assert_eq!(edit_item(named, false, false), EditItem::Off);
        assert_eq!(edit_item(None, true, false), EditItem::Off);
        assert_eq!(edit_item(None, false, false), EditItem::Off);
    }

    #[test]
    fn the_menu_item_calls_the_page_or_falls_back_to_text_undo() {
        let undo = page_step_script(Step::Undo);
        assert!(undo.contains("var u = window.__infallUndo;"));
        assert!(undo.contains("typeof s.undo === 'string' && s.undo !== ''"));
        assert!(undo.contains("u.undo();"));
        assert!(undo.contains("document.execCommand('undo');"));
        assert!(!undo.contains("redo") && !undo.contains("STEP"));
        let redo = page_step_script(Step::Redo);
        assert!(redo.contains("u.redo();"));
        assert!(redo.contains("document.execCommand('redo');"));
        assert!(!redo.contains("undo") && !redo.contains("STEP"));
        // Whatever the page does, nothing escapes into the app.
        assert!(undo.starts_with("(function () { try {") && undo.ends_with("} catch (e) {} })();"));
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
