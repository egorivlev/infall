//! The Runner: the part of the desktop app that executes Runs on the Member's own computer
//! (docs/specs/desktop.md, "M8 — the Runner" and "Languages — Runs in more than Python";
//! docs/specs/pdf-sources.md, Part 2, for environments).
//!
//! Executing a Run means running code someone else may have written, with the Member's own
//! rights. So the order of things in [`Runner::run`] is the security model:
//!
//! 1. what executes it comes from the settings on this device, never from the request: a
//!    Run only *names* its language and, for Python, the environment it wants, and this
//!    device decides what those names start (a name it does not know is asked once, in the
//!    app's own settings window, and remembered);
//! 2. the code goes through the approval [`Gate`](approvals::Gate): the Member approves
//!    exactly this text, as this language, run by this interpreter or program, in the app's
//!    own window, or approved exactly that from the same Workspace before;
//! 3. only the resulting [`Approved`](approvals::Approved) can be executed.
//!
//! There are no Tauri types here. The app implements [`Ui`] (two windows) and forwards
//! events; tests implement it by answering the gate directly.

pub mod approvals;
pub mod envs;
pub mod exec;
pub mod inspect;
pub mod monitor;
pub mod output;
pub mod python;
pub mod settings;
pub mod toolchains;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

pub use approvals::{ApprovalView, Cancel, DecideError};
use approvals::{Decision, Details, Gate, Request, RequestError};
use exec::{Env, Exec, Figure, Launch, Progress};
pub use monitor::Usage;
use python::EnvVars;
pub use settings::Interpreter;
use settings::{NamedEnv, Settings, Toolchain};
use toolchains::{FoundProgram, PYTHON, QSHARP};

/// The environment variable that overrides the interpreter (used by tests). It chooses the
/// program, nothing more: the approval is asked exactly as without it. With it, every Python
/// Run uses it, whatever environment the Run names.
pub const PYTHON_ENV: &str = "INFALL_PYTHON_BIN";

/// The Workspace a Run is asked for from, as the app knows it: nothing here comes from the
/// page.
#[derive(Debug, Clone)]
pub struct Workspace {
    /// What approvals are remembered under: a Team Workspace's origin; for a Local
    /// Workspace, whose address can change between starts, `local:<id>`.
    pub key: String,
    /// How the approval window names it.
    pub name: String,
}

/// The `request` argument of `infallDesktop.runner.run` and `.start`. Everything in it comes
/// from the page: it names things, and the names are only looked up here.
#[derive(Debug, Clone, Deserialize)]
pub struct RunRequest {
    /// Chosen by the caller; identifies the Run for cancel.
    pub id: String,
    pub code: String,
    #[serde(default)]
    pub title: String,
    /// The language's id; absent: `python`.
    #[serde(default)]
    pub lang: Option<String>,
    /// The name of the Python environment the Run asks for; absent or empty: the default.
    #[serde(default)]
    pub env: Option<String>,
}

/// Why a Run did not happen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    Declined,
    NoPython,
    /// The Run's language is not set up on this computer.
    NoToolchain,
    /// The Run names an environment, and none on this computer was chosen for that name.
    NoEnvironment,
    Busy,
    Failed,
}

/// What the page is told (desktop.md: `RunEvent`).
#[derive(Debug, Clone, PartialEq, Serialize)]
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
    /// What the Run is using now (M9): about once a second while the process runs.
    Stats(Usage),
    Done {
        /// The language it was executed as.
        lang: String,
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

/// A language a Run could be executed in now, as `status()` tells the page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LanguageStatus {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// `infallDesktop.runner.status()`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Status {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub python: Option<Interpreter>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    /// Every language a Run could be executed in now, `python` included.
    pub languages: BTreeMap<String, LanguageStatus>,
    /// Every environment name a Run could ask for that runs here without a question.
    pub environments: Vec<String>,
}

/// What the settings window is opened to ask, besides showing everything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Ask {
    /// A Run asks for an environment by this name, and none here is chosen for it.
    Env(String),
    /// A Run is in this language, and it is not set up here (or the page asked to set it up).
    Lang(String),
}

/// An environment as the settings window lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EnvView {
    pub name: String,
    pub kind: envs::Kind,
    pub path: String,
    /// What `--version` said, when it was asked and answered like Python 3.
    pub version: Option<String>,
}

/// A command Toolchain as the settings window lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LanguageView {
    pub id: String,
    pub name: String,
    pub program: String,
    pub args: Vec<String>,
    pub ext: String,
    pub version: Option<String>,
    /// Set when its program, asked its version when it was set up, crashed, failed or did
    /// not answer: why, as a short plain sentence. Absent when it worked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
    pub enabled: bool,
    /// Its program is still there.
    pub available: bool,
}

/// A preset as the settings window lists it: what it would set up, and the programs found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PresetView {
    pub id: String,
    pub name: String,
    pub ext: String,
    pub args: Vec<String>,
    pub found: Vec<FoundProgram>,
}

/// What the Runner settings window shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SettingsView {
    /// The default environment's interpreter, if one is chosen.
    pub python: Option<Interpreter>,
    pub folder: Option<String>,
    /// The interpreters found on the shell's `PATH`.
    pub found: Vec<Interpreter>,
    /// The environments found (conda, pyenv, the folder's venv) and added by hand.
    pub environments: Vec<EnvView>,
    /// A name a Run asks for → the interpreter it means here.
    pub names: BTreeMap<String, String>,
    /// Set when `INFALL_PYTHON_BIN` decides the interpreter instead of the choice here.
    pub overridden: Option<String>,
    /// How many approvals are remembered.
    pub remembered: usize,
    pub qsharp: Option<settings::Qsharp>,
    pub languages: Vec<LanguageView>,
    pub presets: Vec<PresetView>,
    /// What the window was opened to ask, if anything.
    pub ask: Option<Ask>,
}

/// A change made in the settings window, one at a time (the default interpreter and the
/// folder are saved together by [`Runner::settings_save`]).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "do", rename_all = "snake_case")]
pub enum Change {
    /// Adds (or replaces) a Python environment under a name of the Member's choosing.
    AddEnvironment {
        name: String,
        path: String,
    },
    RemoveEnvironment {
        name: String,
    },
    /// What a name a Run asks for means here: an interpreter, or (`None`) nothing chosen.
    Map {
        name: String,
        path: Option<String>,
    },
    /// Q#, hosted by the default Python: on (asks that Python for `qdk`) or off.
    Qsharp {
        on: bool,
    },
    /// Sets up (or replaces) a command Toolchain.
    SetLanguage {
        id: String,
        name: String,
        program: String,
        args: Vec<String>,
        ext: String,
    },
    RemoveLanguage {
        id: String,
    },
    /// The switch of a command Toolchain.
    EnableLanguage {
        id: String,
        on: bool,
    },
}

/// The app's own windows, as the Runner needs them. A page has no part in any of this.
pub trait Ui {
    /// Opens the Runner settings window and returns when it has been closed (or `cancel`
    /// was set). What it is opened to ask is [`Runner::asking`].
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
    /// `INFALL_PYTHON_BIN`, if set.
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

    /// As [`Options::new`], with the interpreter override read from `INFALL_PYTHON_BIN`.
    pub fn from_process_env(config_dir: impl Into<PathBuf>) -> Self {
        let mut options = Self::new(config_dir);
        options.python_override = std::env::var_os(PYTHON_ENV)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from);
        options
    }
}

/// What the settings window shows that takes long to find: kept until "Check again".
#[derive(Debug, Clone, Default)]
struct Looked {
    found: Vec<Interpreter>,
    /// Version by interpreter path, for the environments listed.
    versions: BTreeMap<String, Option<String>>,
    presets: Vec<PresetView>,
}

pub struct Runner {
    options: Options,
    gate: Gate,
    /// The Run in progress, from the moment it is asked for: one at a time per app.
    active: Arc<Mutex<Option<(String, Cancel)>>>,
    env: Mutex<Option<Arc<EnvVars>>>,
    /// The override, checked once.
    overridden: OnceLock<Result<Interpreter, String>>,
    /// What the settings window is being opened to ask.
    asking: Mutex<Option<Ask>>,
    looked: Mutex<Option<Looked>>,
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
/// At most this many environments are asked for their version when the window looks.
const MAX_PROBED: usize = 32;

const MALFORMED: &str = "The desktop app received a request it cannot run.";
const CANCELLED: &str = "The Run was cancelled before it started.";
const NOT_SAVED: &str = "The settings could not be saved on this computer.";

fn error(on_event: &mut dyn FnMut(RunEvent), reason: Reason, message: &str) {
    on_event(RunEvent::Error {
        reason,
        message: message.to_owned(),
    });
}

/// What a Run will be executed with: decided on this device.
enum Plan {
    Python {
        python: Interpreter,
        environment: Option<String>,
    },
    Qsharp {
        python: Interpreter,
        environment: Option<String>,
    },
    Command {
        id: String,
        toolchain: Toolchain,
    },
}

type Refusal = (Reason, String);

impl Runner {
    pub fn new(options: Options) -> Self {
        Self {
            gate: Gate::new(&options.config_dir, options.min_view),
            options,
            active: Arc::default(),
            env: Mutex::new(None),
            overridden: OnceLock::new(),
            asking: Mutex::new(None),
            looked: Mutex::new(None),
        }
    }

    fn config_dir(&self) -> &Path {
        &self.options.config_dir
    }

    fn load(&self) -> Settings {
        settings::load(self.config_dir())
    }

    fn store(&self, settings: &Settings) -> Result<(), String> {
        settings::save(self.config_dir(), settings).map_err(|_| NOT_SAVED.to_owned())
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

    /// The environment as known without starting anything: the login shell's if it was
    /// asked already, else the app's own (for `status()`, which starts nothing).
    fn env_known(&self) -> Arc<EnvVars> {
        if let Some(fixed) = &self.options.env {
            return Arc::new(fixed.clone());
        }
        if let Some(env) = self.env.lock().unwrap().as_ref() {
            return env.clone();
        }
        Arc::new(std::env::vars_os().collect())
    }

    /// The interpreter Runs use by default: the override if there is one, else the Member's
    /// choice if that program still exists. `Ok(None)`: nothing chosen.
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
        Ok(self
            .load()
            .python
            .filter(|p| infall_proc::is_executable_file(Path::new(&p.path))))
    }

    /// The command Toolchain for `id`, if it is set up, switched on and its program is there.
    fn toolchain(settings: &Settings, id: &str) -> Option<Toolchain> {
        settings
            .languages
            .get(id)
            .filter(|t| !t.off && infall_proc::is_executable_file(Path::new(&t.program)))
            .cloned()
    }

    /// The environments found on this device, without starting anything.
    fn discover(&self, env: &EnvVars, settings: &Settings) -> Vec<envs::Found> {
        envs::discover(env, settings.folder.as_deref().map(Path::new))
    }

    /// What Runs would use now, and which languages and environment names are there. Read
    /// from the saved settings and the file system: it starts nothing (except, once, the
    /// check of `INFALL_PYTHON_BIN`).
    pub fn status(&self) -> Status {
        let settings = self.load();
        let python = self.interpreter().ok().flatten();
        let mut languages = BTreeMap::new();
        if let Some(python) = &python {
            languages.insert(
                PYTHON.to_owned(),
                LanguageStatus {
                    name: "Python".into(),
                    version: Some(python.version.clone()),
                },
            );
            if let Some(q) = settings.qsharp.as_ref().filter(|q| !q.off) {
                languages.insert(
                    QSHARP.to_owned(),
                    LanguageStatus {
                        name: "Q#".into(),
                        version: Some(format!("{} {}", q.package, q.version)),
                    },
                );
            }
        }
        for id in settings.languages.keys() {
            if let Some(t) = Self::toolchain(&settings, id) {
                languages.insert(
                    id.clone(),
                    LanguageStatus {
                        name: t.name,
                        version: t.version,
                    },
                );
            }
        }
        let found = self.discover(&self.env_known(), &settings);
        Status {
            python,
            folder: settings.folder.clone(),
            languages,
            environments: envs::known_names(&settings, &found),
        }
    }

    // ---- behind the settings window ----------------------------------------------------

    /// What the settings window is being opened to ask; `None` when nothing.
    pub fn asking(&self) -> Option<Ask> {
        self.asking.lock().unwrap().clone()
    }

    /// Sets what the settings window asks when it is opened next (the page's
    /// `configure(lang)`); `None` once it has been closed.
    pub fn set_asking(&self, ask: Option<Ask>) {
        *self.asking.lock().unwrap() = ask;
    }

    /// Asks the Member, through the settings window, and forgets the question afterwards.
    fn ask(&self, ask: Ask, ui: &dyn Ui, cancel: &Cancel) {
        self.set_asking(Some(ask));
        ui.configure(cancel);
        self.set_asking(None);
    }

    /// Everything the settings window shows. `refresh`: look again for interpreters,
    /// environments' versions and programs (slow: it starts the shell and each candidate);
    /// otherwise what was found last time is reused.
    pub fn settings_view(&self, refresh: bool) -> SettingsView {
        let saved = self.load();
        let cached = if refresh {
            None
        } else {
            self.looked.lock().unwrap().clone()
        };
        let env = self.env(refresh || cached.is_none() && self.options.env.is_none());
        let found_envs = self.discover(&env, &saved);
        let mut looked = cached.unwrap_or_else(|| Looked {
            found: python::find(&env),
            versions: BTreeMap::new(),
            presets: toolchains::PRESETS
                .iter()
                .filter(|p| !(cfg!(windows) && p.windows.is_empty()))
                .map(|p| PresetView {
                    id: p.id.into(),
                    name: p.name.into(),
                    ext: p.ext.into(),
                    args: vec![toolchains::FILE.into()],
                    found: toolchains::find_programs(p, &env),
                })
                .collect(),
        });
        let mut environments: Vec<EnvView> = found_envs
            .iter()
            .map(|f| EnvView {
                name: f.name.clone(),
                kind: f.kind,
                path: f.path.clone(),
                version: None,
            })
            .collect();
        environments.extend(saved.environments.iter().map(|e| EnvView {
            name: e.name.clone(),
            kind: envs::Kind::Added,
            path: e.path.clone(),
            version: Some(e.version.clone()),
        }));
        // Versions of what was found: asked once, then remembered with the rest.
        let mut probed = 0;
        for view in environments.iter_mut().filter(|v| v.version.is_none()) {
            if let Some(version) = looked.versions.get(&view.path) {
                view.version = version.clone();
            } else if probed < MAX_PROBED {
                probed += 1;
                let version = python::validate(&view.path, &env).ok().map(|i| i.version);
                looked.versions.insert(view.path.clone(), version.clone());
                view.version = version;
            }
        }
        let languages = saved
            .languages
            .iter()
            .map(|(id, t)| LanguageView {
                id: id.clone(),
                name: t.name.clone(),
                program: t.program.clone(),
                args: t.args.clone(),
                ext: t.ext.clone(),
                version: t.version.clone(),
                problem: t.problem.clone(),
                enabled: !t.off,
                available: infall_proc::is_executable_file(Path::new(&t.program)),
            })
            .collect();
        let view = SettingsView {
            python: saved.python,
            folder: saved.folder,
            found: looked.found.clone(),
            environments,
            names: saved.names,
            overridden: self
                .options
                .python_override
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
            remembered: self.gate.store().count(),
            qsharp: saved.qsharp,
            languages,
            presets: looked.presets.clone(),
            ask: self.asking(),
        };
        *self.looked.lock().unwrap() = Some(looked);
        view
    }

    /// Saves the Member's choice of the default interpreter and the folder. `python`: the
    /// full path of an interpreter, checked by running `<path> --version`; `None` or empty:
    /// none chosen. `folder`: an existing directory; `None` or empty: a temporary one per
    /// Run. Everything else in the settings is kept. The error is a plain sentence.
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
        let mut settings = self.load();
        // Q# was found in the default Python: another one has to be asked again.
        if settings.python.as_ref().map(|p| &p.path) != python.as_ref().map(|p| &p.path) {
            settings.qsharp = None;
        }
        settings.python = python;
        settings.folder = folder;
        self.store(&settings)
    }

    /// One change made in the settings window. The error is a plain sentence.
    pub fn settings_change(&self, change: Change) -> Result<(), String> {
        let env = self.env(false);
        let mut settings = self.load();
        match change {
            Change::AddEnvironment { name, path } => {
                let name = name.trim().to_owned();
                if !envs::valid_name(&name) {
                    return Err("Give the environment a name of at most 60 characters.".into());
                }
                let python = python::validate(&path, &env)?;
                settings.environments.retain(|e| e.name != name);
                if settings.environments.len() >= envs::MAX_ADDED {
                    return Err("At most 64 environments can be added by hand.".into());
                }
                settings.environments.push(NamedEnv {
                    name,
                    path: python.path,
                    version: python.version,
                });
            }
            Change::RemoveEnvironment { name } => {
                settings.environments.retain(|e| e.name != name);
            }
            Change::Map { name, path } => {
                if !envs::valid_name(&name) {
                    return Err("That name cannot be used for an environment.".into());
                }
                match path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
                    Some(path) => {
                        let python = python::validate(path, &env)?;
                        if !settings.names.contains_key(&name)
                            && settings.names.len() >= envs::MAX_NAMES
                        {
                            return Err("Too many names are remembered. Remove some first.".into());
                        }
                        settings.names.insert(name, python.path);
                    }
                    None => {
                        settings.names.remove(&name);
                    }
                }
            }
            Change::Qsharp { on: false } => {
                if let Some(q) = settings.qsharp.as_mut() {
                    q.off = true;
                }
            }
            Change::Qsharp { on: true } => {
                let Some(python) = self.interpreter().ok().flatten() else {
                    return Err("Choose a Python first: Q# runs through it.".into());
                };
                settings.qsharp = Some(python::qsharp_probe(Path::new(&python.path), &env)?);
            }
            Change::SetLanguage {
                id,
                name,
                program,
                args,
                ext,
            } => {
                if !toolchains::valid_id(&id) {
                    return Err(
                        "A language id is 1 to 24 lowercase letters, digits, - or _, starting \
                         with a letter."
                            .into(),
                    );
                }
                if !toolchains::is_command_id(&id) {
                    return Err("Python and Q# are built in and cannot be set up again.".into());
                }
                if !settings.languages.contains_key(&id)
                    && settings.languages.len() >= toolchains::MAX_LANGUAGES
                {
                    return Err("At most 24 languages can be set up.".into());
                }
                let program = toolchains::check_program(&program)?;
                let mut toolchain = Toolchain {
                    name: name.trim().to_owned(),
                    program,
                    args,
                    ext: ext.trim().trim_start_matches('.').to_owned(),
                    version: None,
                    problem: None,
                    off: false,
                };
                toolchains::check_shape(&toolchain)?;
                // Asked once, when saving. A program that does not work is still taken (the
                // Member chose it by hand, and may know better: some programs fail on
                // `--version` alone), without a version and with why it seems not to work.
                match toolchains::ask_version(Path::new(&toolchain.program), &env) {
                    Ok(version) => toolchain.version = version,
                    Err(problem) => toolchain.problem = Some(problem),
                }
                settings.languages.insert(id, toolchain);
            }
            Change::RemoveLanguage { id } => {
                settings.languages.remove(&id);
            }
            Change::EnableLanguage { id, on } => match settings.languages.get_mut(&id) {
                Some(t) => t.off = !on,
                None => return Err("That language is not set up on this computer.".into()),
            },
        }
        self.store(&settings)
    }

    /// Forgets the approvals remembered for one Workspace (`Workspace::key`): it is gone.
    pub fn forget_approvals_for(&self, key: &str) -> Result<(), String> {
        self.gate
            .store()
            .forget_workspace(key)
            .map_err(|_| "The remembered approvals could not be changed.".to_owned())
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

    /// The default interpreter; the settings window opens when none is chosen.
    fn default_python(&self, ui: &dyn Ui, cancel: &Cancel) -> Result<Interpreter, Refusal> {
        match self.interpreter() {
            Err(message) => Err((Reason::Failed, message)),
            Ok(Some(python)) => Ok(python),
            Ok(None) => {
                // Nothing is chosen until the Member chooses.
                ui.configure(cancel);
                if cancel.is_cancelled() {
                    return Err((Reason::Declined, CANCELLED.into()));
                }
                match self.interpreter() {
                    Ok(Some(python)) => Ok(python),
                    _ => Err((
                        Reason::NoPython,
                        "No Python interpreter is chosen in Runner settings.".into(),
                    )),
                }
            }
        }
    }

    /// The interpreter for a Python (or Q#) Run: the environment it names, as this device
    /// maps that name, else the default. A name this device does not know is asked once.
    fn python_for(
        &self,
        name: Option<&str>,
        ui: &dyn Ui,
        cancel: &Cancel,
    ) -> Result<Interpreter, Refusal> {
        let Some(name) = name else {
            return self.default_python(ui, cancel);
        };
        if self.options.python_override.is_some() {
            return self.default_python(ui, cancel);
        }
        let resolve = || {
            let settings = self.load();
            let found = self.discover(&self.env(false), &settings);
            envs::resolve(name, &settings, &found)
        };
        let path = match resolve() {
            envs::Resolved::Python(path) => path,
            envs::Resolved::Ask => {
                self.ask(Ask::Env(name.to_owned()), ui, cancel);
                if cancel.is_cancelled() {
                    return Err((Reason::Declined, CANCELLED.into()));
                }
                match resolve() {
                    envs::Resolved::Python(path) => path,
                    envs::Resolved::Ask => {
                        return Err((
                            Reason::NoEnvironment,
                            format!(
                                "No environment on this computer is chosen for “{}”.",
                                inspect::display_title(name)
                            ),
                        ));
                    }
                }
            }
        };
        python::validate(&path, &self.env(false)).map_err(|_| {
            (
                Reason::Failed,
                format!(
                    "The environment chosen for “{}” is not a Python 3 interpreter any more. \
                     Choose another in Runner settings.",
                    inspect::display_title(name)
                ),
            )
        })
    }

    /// What this device executes a Run in `lang` with. Asks (once) when it does not know.
    fn plan(
        &self,
        lang: &str,
        environment: Option<String>,
        ui: &dyn Ui,
        cancel: &Cancel,
    ) -> Result<Plan, Refusal> {
        match lang {
            PYTHON => Ok(Plan::Python {
                python: self.python_for(environment.as_deref(), ui, cancel)?,
                environment,
            }),
            QSHARP => {
                let ready = || self.load().qsharp.is_some_and(|q| !q.off);
                if !ready() {
                    self.ask(Ask::Lang(QSHARP.into()), ui, cancel);
                    if cancel.is_cancelled() {
                        return Err((Reason::Declined, CANCELLED.into()));
                    }
                    if !ready() {
                        return Err((
                            Reason::NoToolchain,
                            "Q# is not set up in Runner settings on this computer.".into(),
                        ));
                    }
                }
                Ok(Plan::Qsharp {
                    python: self.python_for(environment.as_deref(), ui, cancel)?,
                    environment,
                })
            }
            id => {
                let toolchain = match Self::toolchain(&self.load(), id) {
                    Some(t) => t,
                    None => {
                        self.ask(Ask::Lang(id.to_owned()), ui, cancel);
                        if cancel.is_cancelled() {
                            return Err((Reason::Declined, CANCELLED.into()));
                        }
                        let settings = self.load();
                        Self::toolchain(&settings, id).ok_or_else(|| {
                            (
                                Reason::NoToolchain,
                                format!(
                                    "{} is not set up in Runner settings on this computer.",
                                    toolchains::language_name(id, settings.languages.get(id))
                                ),
                            )
                        })?
                    }
                };
                Ok(Plan::Command {
                    id: id.to_owned(),
                    toolchain,
                })
            }
        }
    }

    /// One Run, from the request to its end. Every outcome is an event, and the last event
    /// is always `done` or `error`. Blocks until the process is gone.
    ///
    /// `workspace` is the Workspace the main window shows, as the app knows it: approvals
    /// are remembered for it.
    pub fn run(
        &self,
        request: RunRequest,
        workspace: &Workspace,
        ui: &dyn Ui,
        on_event: &mut dyn FnMut(RunEvent),
    ) {
        let RunRequest {
            id,
            code,
            title,
            lang,
            env,
        } = request;
        if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) {
            return error(on_event, Reason::Failed, MALFORMED);
        }
        // Names only. A language id that is not one, or an environment name that cannot be
        // one, is refused before anything is shown or executed.
        let lang = lang.unwrap_or_else(|| PYTHON.to_owned());
        if !toolchains::valid_id(&lang) {
            return error(
                on_event,
                Reason::Failed,
                "The Run names a language that Infall cannot read.",
            );
        }
        let environment = match env.filter(|e| !e.is_empty()) {
            Some(name) if !envs::valid_name(&name) => {
                return error(
                    on_event,
                    Reason::Failed,
                    "The Run names an environment that Infall cannot read.",
                );
            }
            Some(name) if lang == PYTHON || lang == QSHARP => Some(name),
            // Only Python is run in a named environment.
            _ => None,
        };
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

        // 1. What executes it, and where. From this device's settings; nothing here is the
        //    page's but the names it gave.
        let plan = match self.plan(&lang, environment, ui, &cancel) {
            Ok(plan) => plan,
            Err((reason, message)) => return error(on_event, reason, &message),
        };
        let folder = self.load().folder;
        if let Some(folder) = &folder
            && !Path::new(folder).is_dir()
        {
            return error(
                on_event,
                Reason::Failed,
                "The folder chosen in Runner settings does not exist any more.",
            );
        }

        // 2. The Member's approval of exactly this code, as this language, run by this.
        let (language, environment, program, args) = match &plan {
            Plan::Python {
                python,
                environment,
            } => (
                "Python".to_owned(),
                environment.clone(),
                python.path.clone(),
                None,
            ),
            Plan::Qsharp {
                python,
                environment,
            } => (
                "Q#".to_owned(),
                environment.clone(),
                python.path.clone(),
                None,
            ),
            Plan::Command { id, toolchain } => (
                toolchains::language_name(id, Some(toolchain)),
                None,
                toolchain.program.clone(),
                Some(toolchain.args.clone()),
            ),
        };
        let details = Details {
            title,
            from: workspace.name.clone(),
            lang: lang.clone(),
            language,
            environment,
            program,
            args,
            folder: folder.clone(),
        };
        let approved = match self.gate.request(&workspace.key, details, code) {
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

        // 3. Execution: of the approved text, with what was shown.
        let launch = match plan {
            Plan::Python { python, .. } => Launch::Python {
                python: PathBuf::from(&python.path),
                version: Some(python.version),
            },
            Plan::Qsharp { python, .. } => Launch::Qsharp {
                python: PathBuf::from(&python.path),
                version: Some(python.version),
            },
            Plan::Command { toolchain, .. } => Launch::Command {
                program: PathBuf::from(&toolchain.program),
                args: toolchain.args,
                ext: toolchain.ext,
                runtime: toolchain.version,
            },
        };
        let exec = Exec {
            launch,
            folder: folder.map(PathBuf::from),
            env: (*self.env(false)).clone(),
            temp_root: self.options.temp_root.clone(),
            kill_grace: self.options.kill_grace,
        };
        let finished = exec.execute(&approved, &cancel, &mut |progress| {
            on_event(match progress {
                Progress::Started => RunEvent::Started,
                Progress::Output(text) => RunEvent::Output { text },
                Progress::Stats(usage) => RunEvent::Stats(usage),
            });
        });
        match finished {
            Ok(done) => on_event(RunEvent::Done {
                lang,
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
        Some(rest) => match python::home_dir(env) {
            Some(home) => Path::new(home).join(rest),
            None => PathBuf::from(typed),
        },
        None => PathBuf::from(typed),
    };
    if !path.is_absolute() || typed.contains('\0') {
        return Err(if cfg!(windows) {
            "Enter the full path of the folder, starting with the drive (C:\\…)."
        } else {
            "Enter the full path of the folder, starting with /."
        }
        .into());
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
        // `stats` carries the usage's own fields beside the type, not inside another object.
        let stats = RunEvent::Stats(Usage {
            cpu_percent: 99.5,
            cores: 8,
            memory_bytes: 1024,
            memory_total_bytes: 4096,
            processes: 1,
            gpu: None,
            step: Some("sweep".into()),
            progress: Some(monitor::HowFar {
                done: 1.0,
                total: 2.0,
            }),
        });
        assert_eq!(
            json(&stats),
            serde_json::json!({
                "type": "stats", "cpu_percent": 99.5, "cores": 8, "memory_bytes": 1024,
                "memory_total_bytes": 4096, "processes": 1, "step": "sweep",
                "progress": {"done": 1.0, "total": 2.0}
            })
        );
        for (reason, name) in [
            (Reason::Declined, "declined"),
            (Reason::NoPython, "no_python"),
            (Reason::NoToolchain, "no_toolchain"),
            (Reason::NoEnvironment, "no_environment"),
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
            lang: "python".into(),
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
                runtime: None,
            },
        };
        assert_eq!(
            json(&done),
            serde_json::json!({
                "type": "done", "lang": "python", "exit": null, "stopped": true,
                "duration_ms": 12, "code_sha256": "ab", "output": "o",
                "output_truncated": false, "figures": [{"png": "AAAA"}],
                "env": {"python": "3.12.3", "packages": {"numpy": "2.0"}, "os": "macos"}
            })
        );
        // A Run in another language: its Toolchain's version, no Python, no packages.
        let julia = RunEvent::Done {
            lang: "julia".into(),
            exit: Some(0),
            stopped: false,
            duration_ms: 3,
            code_sha256: "cd".into(),
            output: String::new(),
            output_truncated: false,
            figures: Vec::new(),
            env: Env {
                os: Some("linux".into()),
                arch: Some("x86_64".into()),
                runtime: Some("julia version 1.11.2".into()),
                ..Env::default()
            },
        };
        assert_eq!(
            json(&julia)["env"],
            serde_json::json!({"os": "linux", "arch": "x86_64", "runtime": "julia version 1.11.2"})
        );
        assert_eq!(json(&julia)["lang"], "julia");
        assert_eq!(
            serde_json::to_value(Status {
                python: None,
                folder: None,
                languages: BTreeMap::new(),
                environments: Vec::new(),
            })
            .unwrap(),
            serde_json::json!({"languages": {}, "environments": []})
        );
        let status = Status {
            python: Some(Interpreter {
                path: "/usr/bin/python3".into(),
                version: "3.12.3".into(),
            }),
            folder: None,
            languages: [
                (
                    "python".to_owned(),
                    LanguageStatus {
                        name: "Python".into(),
                        version: Some("3.12.3".into()),
                    },
                ),
                (
                    "julia".to_owned(),
                    LanguageStatus {
                        name: "Julia".into(),
                        version: None,
                    },
                ),
            ]
            .into(),
            environments: vec!["analysis".into()],
        };
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            serde_json::json!({
                "python": {"path": "/usr/bin/python3", "version": "3.12.3"},
                "languages": {"julia": {"name": "Julia"}, "python": {"name": "Python", "version": "3.12.3"}},
                "environments": ["analysis"]
            })
        );
        assert_eq!(
            serde_json::to_value(Ask::Env("analysis".into())).unwrap(),
            serde_json::json!({"env": "analysis"})
        );
        assert_eq!(
            serde_json::to_value(Ask::Lang("julia".into())).unwrap(),
            serde_json::json!({"lang": "julia"})
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
        assert_eq!((r.lang, r.env), (None, None));
        // A language and an environment are names, nothing more.
        let r: RunRequest = serde_json::from_str(
            r#"{"id":"r1","code":"println(1)","title":"T","lang":"julia","env":"analysis"}"#,
        )
        .unwrap();
        assert_eq!(r.lang.as_deref(), Some("julia"));
        assert_eq!(r.env.as_deref(), Some("analysis"));
        // The settings window's changes, as its page sends them.
        let change: Change = serde_json::from_str(
            r#"{"do":"set_language","id":"julia","name":"Julia","program":"/bin/julia","args":["{file}"],"ext":"jl"}"#,
        )
        .unwrap();
        assert!(matches!(change, Change::SetLanguage { ref id, .. } if id == "julia"));
        let change: Change =
            serde_json::from_str(r#"{"do":"map","name":"analysis","path":null}"#).unwrap();
        assert!(matches!(change, Change::Map { path: None, .. }));
        assert!(serde_json::from_str::<Change>(r#"{"do":"approve"}"#).is_err());
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
