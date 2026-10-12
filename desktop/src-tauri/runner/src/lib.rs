//! The Runner: the part of the desktop app that executes Runs on the Member's own computer
//! (docs/specs/desktop.md, "M8 — the Runner").
//!
//! Executing a Run means running code someone else may have written, with the Member's own
//! rights. So the order of things in [`Runner::run`] is the security model:
//!
//! 1. the interpreter and the folder come from the settings on this device, never from the
//!    request;
//! 2. the code goes through the approval [`Gate`](approvals::Gate): the Member approves
//!    exactly this text in the app's own window, or approved the same text from the same
//!    server before;
//! 3. only the resulting [`Approved`](approvals::Approved) can be executed.
//!
//! There are no Tauri types here. The app implements [`Ui`] (two windows) and forwards
//! events; tests implement it by answering the gate directly.

pub mod approvals;
pub mod exec;
pub mod inspect;
pub mod output;
pub mod python;
pub mod settings;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

pub use approvals::{ApprovalView, Cancel, DecideError};
use approvals::{Decision, Details, Gate, Request, RequestError};
use exec::{Env, Exec, Figure, Progress};
use python::EnvVars;
pub use settings::Interpreter;

/// The environment variable that overrides the interpreter (used by tests). It chooses the
/// program, nothing more: the approval is asked exactly as without it.
pub const PYTHON_ENV: &str = "QOOP_PYTHON_BIN";

/// The `request` argument of `qoopDesktop.runner.run`. Everything in it comes from the page.
#[derive(Debug, Clone, Deserialize)]
pub struct RunRequest {
    /// Chosen by the caller; identifies the Run for cancel.
    pub id: String,
    pub code: String,
    #[serde(default)]
    pub title: String,
}

/// Why a Run did not happen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    Declined,
    NoPython,
    Busy,
    Failed,
}

/// What the page is told (desktop.md: `RunEvent`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RunEvent {
    /// The app is showing the code to the Member and waits.
    Approval,
    /// The process is running.
    Started,
    /// More standard output / standard error.
    Output {
        text: String,
    },
    Done {
        exit: Option<i32>,
        stopped: bool,
        duration_ms: u64,
        code_sha256: String,
        output: String,
        output_truncated: bool,
        figures: Vec<Figure>,
        env: Env,
    },
    Error {
        reason: Reason,
        message: String,
    },
}

/// `qoopDesktop.runner.status()`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Status {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub python: Option<Interpreter>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
}

/// What the Runner settings window shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SettingsView {
    /// The chosen interpreter, if any.
    pub python: Option<Interpreter>,
    pub folder: Option<String>,
    /// The interpreters found on this computer.
    pub found: Vec<Interpreter>,
    /// Set when `QOOP_PYTHON_BIN` decides the interpreter instead of the choice here.
    pub overridden: Option<String>,
    /// How many approvals are remembered.
    pub remembered: usize,
}

/// The app's own windows, as the Runner needs them. A page has no part in any of this.
pub trait Ui {
    /// Opens the Runner settings window and returns when it has been closed (or `cancel`
    /// was set).
    fn configure(&self, cancel: &Cancel);
    /// Opens the approval window for `ticket`. `false` if it could not be opened.
    fn show_approval(&self, ticket: u64) -> bool;
    /// Closes the approval window for `ticket`, if it is still open.
    fn close_approval(&self, ticket: u64);
}

/// How a [`Runner`] is set up.
#[derive(Debug, Clone)]
pub struct Options {
    /// The app's config directory: settings and remembered approvals live here.
    pub config_dir: PathBuf,
    /// `QOOP_PYTHON_BIN`, if set.
    pub python_override: Option<PathBuf>,
    /// How long the approval window must have shown the code before "Run" counts.
    pub min_view: Duration,
    /// How long a cancelled process gets to stop before it is killed.
    pub kill_grace: Duration,
    /// Where each Run's temporary directory is made.
    pub temp_root: PathBuf,
    /// The environment for interpreters; `None`: ask the Member's login shell.
    pub env: Option<EnvVars>,
}

impl Options {
    pub fn new(config_dir: impl Into<PathBuf>) -> Self {
        Self {
            config_dir: config_dir.into(),
            python_override: None,
            min_view: Duration::from_millis(1000),
            kill_grace: Duration::from_millis(500),
            temp_root: std::env::temp_dir(),
            env: None,
        }
    }

    /// As [`Options::new`], with the interpreter override read from `QOOP_PYTHON_BIN`.
    pub fn from_process_env(config_dir: impl Into<PathBuf>) -> Self {
        let mut options = Self::new(config_dir);
        options.python_override = std::env::var_os(PYTHON_ENV)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from);
        options
    }
}

pub struct Runner {
    options: Options,
    gate: Gate,
    /// The Run in progress, from the moment it is asked for: one at a time per app.
    active: Arc<Mutex<Option<(String, Cancel)>>>,
    env: Mutex<Option<Arc<EnvVars>>>,
    /// The override, checked once.
    overridden: OnceLock<Result<Interpreter, String>>,
}

/// Frees the slot when the Run is over, however it ends.
struct Slot(Arc<Mutex<Option<(String, Cancel)>>>);

impl Drop for Slot {
    fn drop(&mut self) {
        *self.0.lock().unwrap() = None;
    }
}

/// How long a new Run waits for a cancelled one to be gone before it is refused as `busy`.
const STOPPING_WAIT: Duration = Duration::from_secs(4);

const MALFORMED: &str = "The desktop app received a request it cannot run.";
const CANCELLED: &str = "The Run was cancelled before it started.";

fn error(on_event: &mut dyn FnMut(RunEvent), reason: Reason, message: &str) {
    on_event(RunEvent::Error {
        reason,
        message: message.to_owned(),
    });
}

impl Runner {
    pub fn new(options: Options) -> Self {
        Self {
            gate: Gate::new(&options.config_dir, options.min_view),
            options,
            active: Arc::default(),
            env: Mutex::new(None),
            overridden: OnceLock::new(),
        }
    }

    fn config_dir(&self) -> &Path {
        &self.options.config_dir
    }

    /// The environment interpreters get. Asked of the login shell once, then kept.
    fn env(&self, refresh: bool) -> Arc<EnvVars> {
        if let Some(fixed) = &self.options.env {
            return Arc::new(fixed.clone());
        }
        if !refresh && let Some(env) = self.env.lock().unwrap().as_ref() {
            return env.clone();
        }
        // Not under the lock: the shell can take seconds.
        let fresh = Arc::new(python::login_env());
        *self.env.lock().unwrap() = Some(fresh.clone());
        fresh
    }

    /// The interpreter Runs use: the override if there is one, else the Member's choice if
    /// that program still exists. `Ok(None)`: nothing chosen.
    fn interpreter(&self) -> Result<Option<Interpreter>, String> {
        if let Some(path) = &self.options.python_override {
            return self
                .overridden
                .get_or_init(|| {
                    path.to_str()
                        .ok_or(())
                        .and_then(|p| python::validate(p, &self.env(false)).map_err(|_| ()))
                        .map_err(|()| {
                            format!("{PYTHON_ENV} does not point at a Python 3 interpreter.")
                        })
                })
                .clone()
                .map(Some);
        }
        Ok(settings::load(self.config_dir())
            .python
            .filter(|p| qoop_proc::is_executable_file(Path::new(&p.path))))
    }

    /// The interpreter and folder Runs would use now.
    pub fn status(&self) -> Status {
        Status {
            python: self.interpreter().ok().flatten(),
            folder: settings::load(self.config_dir()).folder,
        }
    }

    // ---- behind the settings window ----------------------------------------------------

    /// Looks for interpreters (slow: it starts the shell and each candidate).
    pub fn settings_view(&self) -> SettingsView {
        let env = self.env(true);
        let saved = settings::load(self.config_dir());
        SettingsView {
            python: saved.python,
            folder: saved.folder,
            found: python::find(&env),
            overridden: self
                .options
                .python_override
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
            remembered: self.gate.store().count(),
        }
    }

    /// Saves the Member's choice. `python`: the full path of an interpreter, checked by
    /// running `<path> --version`; `None` or empty: none chosen. `folder`: an existing
    /// directory; `None` or empty: a temporary one per Run. The error is a plain sentence.
    pub fn settings_save(&self, python: Option<&str>, folder: Option<&str>) -> Result<(), String> {
        let env = self.env(false);
        let python = match python.map(str::trim).filter(|p| !p.is_empty()) {
            Some(path) => Some(python::validate(path, &env)?),
            None => None,
        };
        let folder = match folder.map(str::trim).filter(|f| !f.is_empty()) {
            Some(typed) => Some(check_folder(typed, &env)?),
            None => None,
        };
        settings::save(self.config_dir(), &settings::Settings { python, folder })
            .map_err(|_| "The settings could not be saved on this computer.".to_owned())
    }

    /// Forgets every remembered approval: every Run asks again.
    pub fn forget_approvals(&self) -> Result<(), String> {
        self.gate
            .store()
            .forget_all()
            .map_err(|_| "The remembered approvals could not be removed.".to_owned())
    }

    // ---- behind the approval window ------------------------------------------------------

    /// What the approval window for `ticket` shows.
    pub fn approval_view(&self, ticket: u64) -> Option<Arc<ApprovalView>> {
        self.gate.view(ticket)
    }

    /// The Member's answer in the approval window for `ticket`.
    pub fn approval_decide(&self, ticket: u64, run: bool) -> Result<(), DecideError> {
        self.gate.decide(ticket, run)
    }

    /// The approval window for `ticket` was closed.
    pub fn approval_closed(&self, ticket: u64) {
        self.gate.closed(ticket);
    }

    // ---- Runs ----------------------------------------------------------------------------

    /// Stops the Run with this id, if it is the one in progress.
    pub fn cancel(&self, id: &str) {
        if let Some((active, cancel)) = self.active.lock().unwrap().as_ref()
            && active == id
        {
            cancel.cancel();
        }
    }

    /// Stops whatever Run is in progress: the page is going away, or the app is.
    pub fn cancel_all(&self) {
        if let Some((_, cancel)) = self.active.lock().unwrap().as_ref() {
            cancel.cancel();
        }
    }

    pub fn is_idle(&self) -> bool {
        self.active.lock().unwrap().is_none()
    }

    /// One Run, from the request to its end. Every outcome is an event, and the last event
    /// is always `done` or `error`. Blocks until the process is gone.
    ///
    /// `origin` is the server the main window shows, as the app knows it: approvals are
    /// remembered for it.
    pub fn run(
        &self,
        request: RunRequest,
        origin: &str,
        ui: &dyn Ui,
        on_event: &mut dyn FnMut(RunEvent),
    ) {
        let RunRequest { id, code, title } = request;
        if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) {
            return error(on_event, Reason::Failed, MALFORMED);
        }
        let cancel = Cancel::new();
        let waiting_since = Instant::now();
        let _slot = loop {
            let mut active = self.active.lock().unwrap();
            match active.as_ref() {
                None => {
                    *active = Some((id, cancel.clone()));
                    break Slot(self.active.clone());
                }
                // The Run before this one has been told to stop and is on its way out (a
                // page that reloads asks again at once): give it a moment.
                Some((_, previous))
                    if previous.is_cancelled() && waiting_since.elapsed() < STOPPING_WAIT =>
                {
                    drop(active);
                    std::thread::sleep(Duration::from_millis(20));
                }
                Some(_) => {
                    return error(
                        on_event,
                        Reason::Busy,
                        "Another Run is still in progress on this computer.",
                    );
                }
            }
        };
        // Before any window opens: code that could never be run is not worth a question.
        if let Err(message) = inspect::check(&code) {
            return error(on_event, Reason::Failed, message);
        }

        // 1. Where it would run. From this device's settings; nothing here is the page's.
        let python = match self.interpreter() {
            Err(message) => return error(on_event, Reason::Failed, &message),
            Ok(Some(python)) => python,
            Ok(None) => {
                // Nothing is chosen until the Member chooses.
                ui.configure(&cancel);
                if cancel.is_cancelled() {
                    return error(on_event, Reason::Declined, CANCELLED);
                }
                match self.interpreter() {
                    Ok(Some(python)) => python,
                    _ => {
                        return error(
                            on_event,
                            Reason::NoPython,
                            "No Python interpreter is chosen in Runner settings.",
                        );
                    }
                }
            }
        };
        let folder = settings::load(self.config_dir()).folder;
        if let Some(folder) = &folder
            && !Path::new(folder).is_dir()
        {
            return error(
                on_event,
                Reason::Failed,
                "The folder chosen in Runner settings does not exist any more.",
            );
        }

        // 2. The Member's approval of exactly this code.
        let details = Details {
            title,
            python: python.path.clone(),
            folder: folder.clone(),
        };
        let approved = match self.gate.request(origin, details, code) {
            Err(RequestError::Code(message)) => return error(on_event, Reason::Failed, message),
            Err(RequestError::Busy) => {
                return error(
                    on_event,
                    Reason::Busy,
                    "Another Run is still waiting for your answer.",
                );
            }
            Ok(Request::Approved(approved)) => approved,
            Ok(Request::Ask(ticket)) => {
                on_event(RunEvent::Approval);
                let shown = ui.show_approval(ticket);
                if !shown {
                    self.gate.closed(ticket);
                }
                let decision = self.gate.wait(ticket, &cancel);
                ui.close_approval(ticket);
                match decision {
                    Decision::Approved(approved) => approved,
                    Decision::Cancelled => return error(on_event, Reason::Declined, CANCELLED),
                    Decision::Declined if !shown => {
                        return error(
                            on_event,
                            Reason::Failed,
                            "The window that asks for your approval could not be opened.",
                        );
                    }
                    Decision::Declined => {
                        return error(
                            on_event,
                            Reason::Declined,
                            "You chose not to run this code.",
                        );
                    }
                }
            }
        };
        if cancel.is_cancelled() {
            return error(on_event, Reason::Declined, CANCELLED);
        }

        // 3. Execution: of the approved text, with the interpreter and folder shown.
        let exec = Exec {
            python: PathBuf::from(&python.path),
            python_version: Some(python.version),
            folder: folder.map(PathBuf::from),
            env: (*self.env(false)).clone(),
            temp_root: self.options.temp_root.clone(),
            kill_grace: self.options.kill_grace,
        };
        let finished = exec.execute(&approved, &cancel, &mut |progress| {
            on_event(match progress {
                Progress::Started => RunEvent::Started,
                Progress::Output(text) => RunEvent::Output { text },
            });
        });
        match finished {
            Ok(done) => on_event(RunEvent::Done {
                exit: done.exit,
                stopped: done.stopped,
                duration_ms: done.duration_ms,
                code_sha256: approved.sha256().to_owned(),
                output: done.output,
                output_truncated: done.output_truncated,
                figures: done.figures,
                env: done.env,
            }),
            Err(message) => error(on_event, Reason::Failed, &message),
        }
    }
}

/// Checks the folder the Member typed: the full path of an existing directory.
fn check_folder(typed: &str, env: &EnvVars) -> Result<String, String> {
    let path = match typed.strip_prefix("~/") {
        Some(rest) => match python::env_value(env, "HOME") {
            Some(home) => Path::new(home).join(rest),
            None => PathBuf::from(typed),
        },
        None => PathBuf::from(typed),
    };
    if !path.is_absolute() || typed.contains('\0') {
        return Err("Enter the full path of the folder, starting with /.".into());
    }
    if !path.is_dir() {
        return Err("There is no folder at that path.".into());
    }
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "That folder's path cannot be used.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_serialise_as_the_contract_says() {
        let json = |e: &RunEvent| serde_json::to_value(e).unwrap();
        assert_eq!(
            json(&RunEvent::Approval),
            serde_json::json!({"type": "approval"})
        );
        assert_eq!(
            json(&RunEvent::Started),
            serde_json::json!({"type": "started"})
        );
        assert_eq!(
            json(&RunEvent::Output {
                text: "hi\n".into()
            }),
            serde_json::json!({"type": "output", "text": "hi\n"})
        );
        for (reason, name) in [
            (Reason::Declined, "declined"),
            (Reason::NoPython, "no_python"),
            (Reason::Busy, "busy"),
            (Reason::Failed, "failed"),
        ] {
            assert_eq!(
                json(&RunEvent::Error {
                    reason,
                    message: "m".into()
                }),
                serde_json::json!({"type": "error", "reason": name, "message": "m"})
            );
        }
        let done = RunEvent::Done {
            exit: None,
            stopped: true,
            duration_ms: 12,
            code_sha256: "ab".into(),
            output: "o".into(),
            output_truncated: false,
            figures: vec![Figure { png: "AAAA".into() }],
            env: Env {
                python: Some("3.12.3".into()),
                packages: Some([("numpy".to_owned(), "2.0".to_owned())].into()),
                os: Some("macos".into()),
                arch: None,
            },
        };
        assert_eq!(
            json(&done),
            serde_json::json!({
                "type": "done", "exit": null, "stopped": true, "duration_ms": 12,
                "code_sha256": "ab", "output": "o", "output_truncated": false,
                "figures": [{"png": "AAAA"}],
                "env": {"python": "3.12.3", "packages": {"numpy": "2.0"}, "os": "macos"}
            })
        );
        assert_eq!(
            serde_json::to_value(Status {
                python: None,
                folder: None
            })
            .unwrap(),
            serde_json::json!({})
        );
    }

    #[test]
    fn the_request_json_of_the_web_ui_deserialises() {
        let r: RunRequest =
            serde_json::from_str(r#"{"id":"r1","code":"print(1)","title":"T"}"#).unwrap();
        assert_eq!(
            (r.id.as_str(), r.code.as_str(), r.title.as_str()),
            ("r1", "print(1)", "T")
        );
        // It has no way to name an interpreter, a folder, or an approval: unknown keys are
        // simply not part of the type.
        let r: RunRequest = serde_json::from_str(
            r#"{"id":"r1","code":"print(1)","title":"T","python":"/tmp/evil","folder":"/","approved":true}"#,
        )
        .unwrap();
        assert_eq!(r.code, "print(1)");
        assert!(serde_json::from_str::<RunRequest>(r#"{"id":"r1"}"#).is_err());
    }

    #[test]
    fn folders_must_exist() {
        let dir = tempfile::tempdir().unwrap();
        let env: EnvVars = vec![("HOME".into(), dir.path().into())];
        std::fs::create_dir(dir.path().join("research")).unwrap();
        std::fs::write(dir.path().join("file.txt"), "").unwrap();
        let ok = dir.path().join("research");
        assert_eq!(
            check_folder(ok.to_str().unwrap(), &env),
            Ok(ok.to_str().unwrap().to_owned())
        );
        assert_eq!(
            check_folder("~/research", &env),
            Ok(ok.to_str().unwrap().to_owned())
        );
        assert_eq!(
            check_folder("research", &env).unwrap_err(),
            "Enter the full path of the folder, starting with /."
        );
        for missing in [dir.path().join("nope"), dir.path().join("file.txt")] {
            assert_eq!(
                check_folder(missing.to_str().unwrap(), &env).unwrap_err(),
                "There is no folder at that path."
            );
        }
    }
}
