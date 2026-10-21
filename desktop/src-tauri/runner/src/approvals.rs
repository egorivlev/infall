//! Approval: code is executed only after the Member said yes to exactly that code in the
//! app's own window, or said yes to the same code from the same Workspace before.
//!
//! The window is only a face for this module: it reads [`Gate::view`] and calls
//! [`Gate::decide`]. Tests do the same, so they exercise the rule itself. Nothing else
//! produces an [`Approved`], and the execution layer accepts nothing else. There is no switch
//! that skips this, in any build.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::inspect::{self, Part};

/// How many approvals are remembered; the oldest are forgotten first.
pub const MAX_REMEMBERED: usize = 1000;

const FILE: &str = "runner-approvals.json";

/// Stops a Run from another thread: before it starts, while it waits, or while it executes.
#[derive(Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

// ---- what was approved before ------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Entry {
    /// The Workspace's key (`crate::Workspace::key`). Kept under its first name, `origin`:
    /// a Team Workspace's key is its origin, so what earlier versions remembered still holds.
    #[serde(rename = "origin")]
    workspace: String,
    sha256: String,
    /// Unix milliseconds.
    at: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct Stored {
    v: u32,
    /// Newest first.
    approved: Vec<Entry>,
}

/// The approvals remembered on this device: which code (by SHA-256) from which Workspace.
pub struct Store {
    path: PathBuf,
}

impl Store {
    pub fn new(config_dir: &Path) -> Self {
        Self {
            path: config_dir.join(FILE),
        }
    }

    fn load(&self) -> Vec<Entry> {
        let Ok(text) = fs::read_to_string(&self.path) else {
            return Vec::new();
        };
        let Ok(stored) = serde_json::from_str::<Stored>(&text) else {
            return Vec::new();
        };
        let mut entries = stored.approved;
        entries.retain(|e| is_sha256(&e.sha256) && !e.workspace.is_empty());
        entries.truncate(MAX_REMEMBERED);
        entries
    }

    fn save(&self, entries: &[Entry]) -> io::Result<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let text = serde_json::to_string(&Stored {
            v: 1,
            approved: entries.to_vec(),
        })?;
        let tmp = self.path.with_extension("json.tmp");
        let _ = fs::remove_file(&tmp);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        fs::rename(tmp, &self.path)
    }

    /// Was this code approved before for this Workspace?
    pub fn contains(&self, workspace: &str, sha256: &str) -> bool {
        self.load()
            .iter()
            .any(|e| e.workspace == workspace && e.sha256 == sha256)
    }

    /// Remembers an approval as the newest one.
    pub fn remember(&self, workspace: &str, sha256: &str) -> io::Result<()> {
        let mut entries = self.load();
        entries.retain(|e| !(e.workspace == workspace && e.sha256 == sha256));
        entries.insert(
            0,
            Entry {
                workspace: workspace.to_owned(),
                sha256: sha256.to_owned(),
                at: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
            },
        );
        entries.truncate(MAX_REMEMBERED);
        self.save(&entries)
    }

    /// How many approvals are remembered.
    pub fn count(&self) -> usize {
        self.load().len()
    }

    /// Forgets the approvals of one Workspace.
    pub fn forget_workspace(&self, workspace: &str) -> io::Result<()> {
        let mut entries = self.load();
        let before = entries.len();
        entries.retain(|e| e.workspace != workspace);
        if entries.len() == before {
            return Ok(());
        }
        self.save(&entries)
    }

    /// Forgets every approval: every Run asks again.
    pub fn forget_all(&self) -> io::Result<()> {
        match fs::remove_file(&self.path) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }
}

fn is_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

// ---- the question ------------------------------------------------------------------------

/// What an approval is remembered under: the code alone when it runs in a temporary folder,
/// the code together with the folder when one is set. Code approved for an empty temporary
/// folder is so not approved for a folder holding the Member's files, nor for another one.
fn remembered_key(code_sha256: &str, folder: Option<&str>) -> String {
    match folder {
        None => code_sha256.to_owned(),
        Some(folder) => inspect::sha256_hex(&format!("{code_sha256}\n{folder}")),
    }
}

/// What the Member is asked about, besides the code. Chosen by the app, never by the page.
#[derive(Debug, Clone)]
pub struct Details {
    /// The Run's title, as the page gave it.
    pub title: String,
    /// The Workspace it comes from, as the window names it: a Team Workspace's server, a
    /// Local Workspace's name.
    pub from: String,
    /// The interpreter that will execute the code.
    pub python: String,
    /// The folder it will run in; `None` for a new temporary folder.
    pub folder: Option<String>,
}

/// Everything the approval window shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ApprovalView {
    pub title: String,
    /// Where the code comes from ([`Details::from`]). Named `origin` for the approval
    /// window, which shows it under "From server".
    pub origin: String,
    pub python: String,
    pub folder: Option<String>,
    pub lines: Vec<Vec<Part>>,
    pub line_count: usize,
    pub char_count: usize,
    pub notices: Vec<String>,
    pub sha256: String,
    /// How long the window keeps "Run on this computer" disabled after it appears.
    pub wait_ms: u64,
}

/// Code the Member approved. The only way to get one is through a [`Gate`], and the
/// execution layer runs nothing else. It holds the very text that was shown and hashed.
pub struct Approved {
    code: Arc<str>,
    sha256: String,
}

impl Approved {
    /// The code to execute: the same text the approval window was given.
    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn sha256(&self) -> &str {
        &self.sha256
    }
}

/// The answer to [`Gate::request`].
pub enum Request {
    /// This code was approved before for this Workspace.
    Approved(Approved),
    /// The Member has to be asked: show the window for this ticket, then [`Gate::wait`].
    Ask(u64),
}

#[derive(Debug, PartialEq, Eq)]
pub enum RequestError {
    /// The code cannot be shown for approval at all (empty, too long). A plain sentence.
    Code(&'static str),
    /// Another question is still open.
    Busy,
}

/// How a question ended.
pub enum Decision {
    Approved(Approved),
    Declined,
    Cancelled,
}

#[derive(Debug, PartialEq, Eq)]
pub enum DecideError {
    /// There is no open question with this ticket (it was answered, cancelled, or replaced).
    Stale,
    /// "Run" came before the window had shown the code for long enough to be read at all.
    TooSoon,
}

struct Pending {
    ticket: u64,
    workspace: String,
    code: Arc<str>,
    sha256: String,
    /// What the approval is remembered under: see [`remembered_key`].
    key: String,
    view: Arc<ApprovalView>,
    /// When the window first asked for the view.
    shown: Option<Instant>,
    verdict: Option<bool>,
}

/// The one place approvals are decided.
pub struct Gate {
    store: Store,
    /// "Run" is refused until the window has had the code for this long: a window that pops
    /// up under a click or key press meant for something else must not count as a yes.
    min_view: Duration,
    state: Mutex<GateState>,
    changed: Condvar,
}

#[derive(Default)]
struct GateState {
    next_ticket: u64,
    pending: Option<Pending>,
}

impl Gate {
    pub fn new(config_dir: &Path, min_view: Duration) -> Self {
        Self {
            store: Store::new(config_dir),
            min_view,
            state: Mutex::new(GateState::default()),
            changed: Condvar::new(),
        }
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    /// Asks for `code` from the Workspace with the key `workspace` to be executed.
    pub fn request(
        &self,
        workspace: &str,
        details: Details,
        code: String,
    ) -> Result<Request, RequestError> {
        inspect::check(&code).map_err(RequestError::Code)?;
        let sha256 = inspect::sha256_hex(&code);
        let code: Arc<str> = Arc::from(code);
        let key = remembered_key(&sha256, details.folder.as_deref());
        if self.store.contains(workspace, &key) {
            return Ok(Request::Approved(Approved { code, sha256 }));
        }
        let mut state = self.state.lock().unwrap();
        if state.pending.is_some() {
            return Err(RequestError::Busy);
        }
        state.next_ticket += 1;
        let ticket = state.next_ticket;
        let shown = inspect::inspect(&code);
        let view = ApprovalView {
            title: inspect::display_title(&details.title),
            origin: details.from,
            python: details.python,
            folder: details.folder,
            lines: shown.lines,
            line_count: shown.line_count,
            char_count: shown.char_count,
            notices: shown.notices,
            sha256: sha256.clone(),
            wait_ms: self.min_view.as_millis() as u64,
        };
        state.pending = Some(Pending {
            ticket,
            workspace: workspace.to_owned(),
            code,
            sha256,
            key,
            view: Arc::new(view),
            shown: None,
            verdict: None,
        });
        Ok(Request::Ask(ticket))
    }

    /// What the window for `ticket` shows. `None` when that question is no longer open.
    pub fn view(&self, ticket: u64) -> Option<Arc<ApprovalView>> {
        let mut state = self.state.lock().unwrap();
        let pending = state.pending.as_mut().filter(|p| p.ticket == ticket)?;
        if pending.verdict.is_some() {
            return None;
        }
        pending.shown.get_or_insert_with(Instant::now);
        Some(pending.view.clone())
    }

    /// The Member's answer, from the window for `ticket`.
    pub fn decide(&self, ticket: u64, run: bool) -> Result<(), DecideError> {
        let mut state = self.state.lock().unwrap();
        let pending = state
            .pending
            .as_mut()
            .filter(|p| p.ticket == ticket && p.verdict.is_none())
            .ok_or(DecideError::Stale)?;
        if run {
            // A yes needs the code to have been on screen.
            let seen = pending
                .shown
                .is_some_and(|at| at.elapsed() >= self.min_view);
            if !seen {
                return Err(DecideError::TooSoon);
            }
            // If this cannot be written the Run still goes ahead; it will just ask again.
            let _ = self.store.remember(&pending.workspace, &pending.key);
        }
        pending.verdict = Some(run);
        self.changed.notify_all();
        Ok(())
    }

    /// The window for `ticket` was closed. Without an answer, that is "Don't run".
    pub fn closed(&self, ticket: u64) {
        let _ = self.decide(ticket, false);
    }

    /// Waits for the answer to `ticket`, or for `cancel`. The question is over afterwards.
    pub fn wait(&self, ticket: u64, cancel: &Cancel) -> Decision {
        let mut state = self.state.lock().unwrap();
        loop {
            let Some(pending) = state.pending.as_ref().filter(|p| p.ticket == ticket) else {
                return Decision::Declined;
            };
            if cancel.is_cancelled() {
                state.pending = None;
                return Decision::Cancelled;
            }
            if let Some(run) = pending.verdict {
                let pending = state.pending.take().expect("checked above");
                return if run {
                    Decision::Approved(Approved {
                        code: pending.code,
                        sha256: pending.sha256,
                    })
                } else {
                    Decision::Declined
                };
            }
            state = self
                .changed
                .wait_timeout(state, Duration::from_millis(40))
                .unwrap()
                .0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    const ORIGIN: &str = "https://qoop.example.org";
    const OTHER: &str = "https://other.example.org";

    fn gate(dir: &Path) -> Gate {
        Gate::new(dir, Duration::ZERO)
    }

    fn details() -> Details {
        Details {
            title: "Bell state".into(),
            from: ORIGIN.into(),
            python: "/usr/bin/python3".into(),
            folder: None,
        }
    }

    fn ask(gate: &Gate, origin: &str, code: &str) -> u64 {
        match gate.request(origin, details(), code.to_owned()) {
            Ok(Request::Ask(ticket)) => ticket,
            Ok(Request::Approved(_)) => panic!("ran without asking"),
            Err(e) => panic!("{e:?}"),
        }
    }

    fn remembered(gate: &Gate, origin: &str, code: &str) -> bool {
        match gate.request(origin, details(), code.to_owned()) {
            Ok(Request::Approved(a)) => {
                assert_eq!(a.code(), code);
                true
            }
            Ok(Request::Ask(ticket)) => {
                gate.closed(ticket);
                assert!(matches!(
                    gate.wait(ticket, &Cancel::new()),
                    Decision::Declined
                ));
                false
            }
            Err(e) => panic!("{e:?}"),
        }
    }

    /// Plays the Member: looks at the window, answers.
    fn answer(gate: &Gate, ticket: u64, run: bool) -> Decision {
        assert!(gate.view(ticket).is_some());
        gate.decide(ticket, run).unwrap();
        gate.wait(ticket, &Cancel::new())
    }

    #[test]
    fn nothing_is_approved_until_the_member_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let gate = gate(dir.path());
        let ticket = ask(&gate, ORIGIN, "print(1)\n");
        let view = gate.view(ticket).unwrap();
        assert_eq!(view.title, "Bell state");
        assert_eq!(view.origin, ORIGIN);
        assert_eq!(view.python, "/usr/bin/python3");
        assert_eq!(view.folder, None);
        assert_eq!(view.line_count, 1);
        assert_eq!(view.sha256, inspect::sha256_hex("print(1)\n"));

        // Nobody answers: the wait only ends when the Run is cancelled.
        let cancel = Cancel::new();
        let stopper = cancel.clone();
        let waited = Instant::now();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(250));
            stopper.cancel();
        });
        assert!(matches!(gate.wait(ticket, &cancel), Decision::Cancelled));
        assert!(waited.elapsed() >= Duration::from_millis(200));
        // And the cancelled question cannot be answered afterwards.
        assert_eq!(gate.decide(ticket, true), Err(DecideError::Stale));
        assert!(gate.view(ticket).is_none());
        assert!(!remembered(&gate, ORIGIN, "print(1)\n"));
    }

    #[test]
    fn approved_code_is_the_code_that_was_shown_and_is_remembered() {
        let dir = tempfile::tempdir().unwrap();
        let gate = gate(dir.path());
        let code = "import os\nprint('héllo')\n";
        let ticket = ask(&gate, ORIGIN, code);
        let Decision::Approved(approved) = answer(&gate, ticket, true) else {
            panic!("not approved");
        };
        assert_eq!(approved.code(), code);
        assert_eq!(approved.sha256(), inspect::sha256_hex(code));

        // The same code from the same server: no question.
        assert!(remembered(&gate, ORIGIN, code));
        // Also for a new Gate over the same folder (the app was restarted).
        assert!(remembered(
            &super::Gate::new(dir.path(), Duration::ZERO),
            ORIGIN,
            code
        ));
        // Another server asks again, even for the same code.
        assert!(!remembered(&gate, OTHER, code));
        // Any change to the code asks again: one character, a trailing newline, a space.
        for changed in [
            "import os\nprint('hello')\n",
            "import os\nprint('héllo')",
            "import os\nprint('héllo')\n\n",
            "import os \nprint('héllo')\n",
            "import os\r\nprint('héllo')\r\n",
        ] {
            assert!(!remembered(&gate, ORIGIN, changed), "{changed:?}");
        }
        // Declining those did not make them remembered, nor forget the first.
        assert!(!remembered(&gate, ORIGIN, "import os\nprint('hello')\n"));
        assert!(remembered(&gate, ORIGIN, code));
    }

    #[test]
    fn declining_runs_nothing_and_remembers_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let gate = gate(dir.path());
        let ticket = ask(&gate, ORIGIN, "print(1)");
        assert!(matches!(answer(&gate, ticket, false), Decision::Declined));
        assert_eq!(gate.store().count(), 0);
        assert!(!dir.path().join(FILE).exists());
        // It asks again next time.
        let ticket = ask(&gate, ORIGIN, "print(1)");
        assert!(matches!(answer(&gate, ticket, false), Decision::Declined));
    }

    #[test]
    fn closing_the_window_declines() {
        let dir = tempfile::tempdir().unwrap();
        let gate = gate(dir.path());
        let ticket = ask(&gate, ORIGIN, "print(1)");
        assert!(gate.view(ticket).is_some());
        gate.closed(ticket);
        // A "Run" arriving after the window closed is too late.
        assert_eq!(gate.decide(ticket, true), Err(DecideError::Stale));
        assert!(matches!(
            gate.wait(ticket, &Cancel::new()),
            Decision::Declined
        ));
        assert_eq!(gate.store().count(), 0);

        // Closed before it ever showed anything: also declined.
        let ticket = ask(&gate, ORIGIN, "print(1)");
        gate.closed(ticket);
        assert!(matches!(
            gate.wait(ticket, &Cancel::new()),
            Decision::Declined
        ));
        // Closing a window of an old question does not touch a new one.
        let new = ask(&gate, ORIGIN, "print(2)");
        gate.closed(ticket);
        assert!(gate.view(new).is_some());
        assert!(matches!(answer(&gate, new, true), Decision::Approved(_)));
    }

    #[test]
    fn an_answer_only_counts_for_the_question_it_was_given_to() {
        let dir = tempfile::tempdir().unwrap();
        let gate = gate(dir.path());
        // A window is showing harmless code...
        let harmless = ask(&gate, ORIGIN, "print('harmless')");
        assert!(gate.view(harmless).is_some());
        // ...the page cancels and asks for something else before the Member clicks.
        let cancel = Cancel::new();
        cancel.cancel();
        assert!(matches!(gate.wait(harmless, &cancel), Decision::Cancelled));
        let other = ask(&gate, ORIGIN, "import shutil; shutil.rmtree('/')");
        assert_ne!(harmless, other);
        // The click on the old window approves nothing.
        assert_eq!(gate.decide(harmless, true), Err(DecideError::Stale));
        assert!(gate.view(harmless).is_none());
        gate.closed(other);
        assert!(matches!(
            gate.wait(other, &Cancel::new()),
            Decision::Declined
        ));
        assert_eq!(gate.store().count(), 0);
        // Unknown tickets are nothing.
        assert_eq!(gate.decide(9999, true), Err(DecideError::Stale));
        assert_eq!(gate.decide(0, true), Err(DecideError::Stale));
    }

    #[test]
    fn one_question_at_a_time() {
        let dir = tempfile::tempdir().unwrap();
        let gate = gate(dir.path());
        let ticket = ask(&gate, ORIGIN, "print(1)");
        assert!(matches!(
            gate.request(ORIGIN, details(), "print(2)".into()),
            Err(RequestError::Busy)
        ));
        // The first question is untouched.
        assert!(matches!(answer(&gate, ticket, true), Decision::Approved(_)));
    }

    #[test]
    fn yes_needs_the_code_to_have_been_on_screen() {
        let dir = tempfile::tempdir().unwrap();
        let gate = Gate::new(dir.path(), Duration::from_millis(300));
        let ticket = ask(&gate, ORIGIN, "print(1)");
        // The window has not shown anything yet.
        assert_eq!(gate.decide(ticket, true), Err(DecideError::TooSoon));
        let view = gate.view(ticket).unwrap();
        assert_eq!(view.wait_ms, 300);
        // It has only just appeared: a click that was on its way somewhere else.
        assert_eq!(gate.decide(ticket, true), Err(DecideError::TooSoon));
        assert_eq!(gate.store().count(), 0);
        thread::sleep(Duration::from_millis(350));
        // Asking for the view again does not restart or skip the wait.
        assert!(gate.view(ticket).is_some());
        assert_eq!(gate.decide(ticket, true), Ok(()));
        assert!(matches!(
            gate.wait(ticket, &Cancel::new()),
            Decision::Approved(_)
        ));

        // "Don't run" never has to wait.
        let ticket = ask(&gate, ORIGIN, "print(2)");
        assert_eq!(gate.decide(ticket, false), Ok(()));
        assert!(matches!(
            gate.wait(ticket, &Cancel::new()),
            Decision::Declined
        ));
    }

    #[test]
    fn code_that_cannot_be_shown_is_refused_without_asking() {
        let dir = tempfile::tempdir().unwrap();
        let gate = gate(dir.path());
        assert!(matches!(
            gate.request(ORIGIN, details(), String::new()),
            Err(RequestError::Code(_))
        ));
        assert!(matches!(
            gate.request(ORIGIN, details(), "x".repeat(inspect::MAX_CODE_CHARS + 1)),
            Err(RequestError::Code(_))
        ));
        // Neither left a question open.
        let ticket = ask(&gate, ORIGIN, "print(1)");
        gate.closed(ticket);
    }

    #[test]
    fn the_newest_thousand_are_remembered() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let sha = |n: usize| inspect::sha256_hex(&format!("print({n})"));
        // Written in one go (a thousand separate saves would only make the test slow).
        let entries: Vec<Entry> = (0..MAX_REMEMBERED)
            .rev()
            .map(|n| Entry {
                workspace: ORIGIN.into(),
                sha256: sha(n),
                at: n as u64,
            })
            .collect();
        store.save(&entries).unwrap();
        assert_eq!(store.count(), MAX_REMEMBERED);
        assert!(store.contains(ORIGIN, &sha(0)));
        assert!(store.contains(ORIGIN, &sha(MAX_REMEMBERED - 1)));

        // One more: the oldest goes.
        store.remember(ORIGIN, &sha(5000)).unwrap();
        assert_eq!(store.count(), MAX_REMEMBERED);
        assert!(store.contains(ORIGIN, &sha(5000)));
        assert!(!store.contains(ORIGIN, &sha(0)));
        assert!(store.contains(ORIGIN, &sha(1)));

        // Approving something again makes it the newest instead of adding it twice.
        store.remember(ORIGIN, &sha(1)).unwrap();
        assert_eq!(store.count(), MAX_REMEMBERED);
        store.remember(ORIGIN, &sha(5001)).unwrap();
        assert!(store.contains(ORIGIN, &sha(1)));
        assert!(!store.contains(ORIGIN, &sha(2)));

        // A file with more than a thousand entries (edited by hand) is read as a thousand.
        let many: Vec<Entry> = (0..MAX_REMEMBERED + 50)
            .map(|n| Entry {
                workspace: ORIGIN.into(),
                sha256: sha(n),
                at: 0,
            })
            .collect();
        store.save(&many).unwrap();
        assert_eq!(store.count(), MAX_REMEMBERED);
        assert!(!store.contains(ORIGIN, &sha(MAX_REMEMBERED + 10)));
    }

    #[test]
    fn the_file_is_private_and_a_broken_one_approves_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("nested/config");
        let store = Store::new(&config);
        assert_eq!(store.count(), 0);
        let sha = inspect::sha256_hex("print(1)");
        store.remember(ORIGIN, &sha).unwrap();
        assert!(store.contains(ORIGIN, &sha));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(config.join(FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert!(!config.join("runner-approvals.json.tmp").exists());

        for text in [
            "",
            "not json",
            "[]",
            r#"{"v":1,"approved":"all"}"#,
            r#"{"v":1,"approved":[{"origin":"https://qoop.example.org","sha256":"*","at":0}]}"#,
            r#"{"v":1,"approved":[{"origin":"","sha256":"","at":0}]}"#,
        ] {
            fs::write(config.join(FILE), text).unwrap();
            assert_eq!(store.count(), 0, "{text}");
            assert!(!store.contains(ORIGIN, &sha), "{text}");
            assert!(!store.contains("", ""), "{text}");
            assert!(!store.contains(ORIGIN, "*"), "{text}");
        }

        store.remember(ORIGIN, &sha).unwrap();
        store.forget_all().unwrap();
        assert_eq!(store.count(), 0);
        store.forget_all().unwrap();
    }

    #[test]
    fn an_approval_does_not_carry_over_to_another_folder() {
        let dir = tempfile::tempdir().unwrap();
        let gate = gate(dir.path());
        let code = "print(open('data.csv').read())\n";
        let with = |folder: Option<&str>| Details {
            folder: folder.map(str::to_owned),
            ..details()
        };
        let asks = |gate: &Gate, folder: Option<&str>| match gate.request(
            ORIGIN,
            with(folder),
            code.to_owned(),
        ) {
            Ok(Request::Ask(ticket)) => {
                gate.closed(ticket);
                gate.wait(ticket, &Cancel::new());
                true
            }
            Ok(Request::Approved(_)) => false,
            Err(_) => panic!("refused"),
        };
        // Approved for a temporary folder.
        let Ok(Request::Ask(ticket)) = gate.request(ORIGIN, with(None), code.to_owned()) else {
            panic!("expected a question");
        };
        assert!(matches!(answer(&gate, ticket, true), Decision::Approved(_)));
        assert!(!asks(&gate, None));
        // A folder of the Member's own, set later: asked again; and again for another.
        assert!(asks(&gate, Some("/Users/me/research")));
        let Ok(Request::Ask(ticket)) =
            gate.request(ORIGIN, with(Some("/Users/me/research")), code.to_owned())
        else {
            panic!("expected a question");
        };
        assert!(matches!(answer(&gate, ticket, true), Decision::Approved(_)));
        assert!(!asks(&gate, Some("/Users/me/research")));
        assert!(asks(&gate, Some("/Users/me/other")));
    }

    #[test]
    fn a_local_workspace_is_named_in_the_window_and_remembered_by_its_key() {
        let dir = tempfile::tempdir().unwrap();
        let gate = gate(dir.path());
        let code = "print('walk')\n";
        let local = "local:0123abcd";
        let named = || Details {
            from: "Tutorial (on this computer)".into(),
            ..details()
        };
        let Ok(Request::Ask(ticket)) = gate.request(local, named(), code.to_owned()) else {
            panic!("the first time asks");
        };
        // The window names the Workspace, not the address it happens to have.
        assert_eq!(
            gate.view(ticket).unwrap().origin,
            "Tutorial (on this computer)"
        );
        assert!(matches!(answer(&gate, ticket, true), Decision::Approved(_)));
        // Remembered under the key, whatever name or address comes with it next time.
        assert!(matches!(
            gate.request(local, details(), code.to_owned()),
            Ok(Request::Approved(_))
        ));
        // Not for another Local Workspace, nor for a server.
        assert!(!remembered(&gate, "local:ffff0000", code));
        assert!(!remembered(&gate, "http://127.0.0.1:53124", code));
    }

    #[test]
    fn a_workspaces_approvals_can_be_forgotten_alone() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let sha = inspect::sha256_hex("print(1)");
        store.remember("local:aaaa", &sha).unwrap();
        store.remember("local:bbbb", &sha).unwrap();
        store.remember(ORIGIN, &sha).unwrap();
        store.forget_workspace("local:aaaa").unwrap();
        assert!(!store.contains("local:aaaa", &sha));
        assert!(store.contains("local:bbbb", &sha));
        assert!(store.contains(ORIGIN, &sha));
        // Nothing to forget is not an error.
        store.forget_workspace("local:cccc").unwrap();
        assert_eq!(store.count(), 2);
    }

    #[test]
    fn what_an_earlier_version_remembered_for_a_server_still_holds() {
        let dir = tempfile::tempdir().unwrap();
        let sha = inspect::sha256_hex("print(1)");
        fs::write(
            dir.path().join(FILE),
            format!(r#"{{"v":1,"approved":[{{"origin":"{ORIGIN}","sha256":"{sha}","at":1}}]}}"#),
        )
        .unwrap();
        let store = Store::new(dir.path());
        assert!(store.contains(ORIGIN, &sha));
        store.remember(OTHER, &sha).unwrap();
        let text = fs::read_to_string(dir.path().join(FILE)).unwrap();
        assert!(
            text.contains(r#""origin":"https://qoop.example.org""#),
            "{text}"
        );
    }
}
