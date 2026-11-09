//! The Runner against a real Python interpreter: approval, execution, output, figures,
//! stopping, the monitor. Nothing here is stubbed; the "Member" answers the approval through the same
//! calls the app's approval window makes.
//!
//! Which interpreter: `QOOP_TEST_PYTHON` if set, else the first one the Runner's own lookup
//! finds that has matplotlib, else the first it finds. Without any, every test here prints
//! a SKIPPED line and passes; without matplotlib, the figure tests do.
#![cfg(unix)]

use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use qoop_runner::python::{self, EnvVars};
use qoop_runner::{
    ApprovalView, Cancel, DecideError, Options, Reason, RunEvent, RunRequest, Runner, Ui, Usage,
    Workspace, inspect,
};

const ORIGIN: &str = "https://qoop.example.org";

/// A Team Workspace: approvals are remembered under its origin, which is also what the
/// approval window shows.
fn workspace() -> Workspace {
    Workspace {
        key: ORIGIN.to_owned(),
        name: ORIGIN.to_owned(),
    }
}

struct TestPython {
    path: String,
    env: EnvVars,
    matplotlib: bool,
}

fn test_python() -> Option<&'static TestPython> {
    static FOUND: OnceLock<Option<TestPython>> = OnceLock::new();
    FOUND
        .get_or_init(|| {
            let env = python::login_env();
            let has_matplotlib = |path: &str| {
                Command::new(path)
                    .args(["-c", "import matplotlib.pyplot"])
                    .env_clear()
                    .envs(env.iter().map(|(k, v)| (k, v)))
                    .env("MPLBACKEND", "Agg")
                    .output()
                    .is_ok_and(|o| o.status.success())
            };
            let mut candidates: Vec<String> = Vec::new();
            if let Some(path) = std::env::var_os("QOOP_TEST_PYTHON") {
                candidates.push(path.to_string_lossy().into_owned());
            } else {
                candidates.extend(python::find(&env).into_iter().map(|i| i.path));
            }
            let path = candidates
                .iter()
                .find(|p| has_matplotlib(p))
                .or(candidates.first())?
                .clone();
            let matplotlib = has_matplotlib(&path);
            eprintln!("Runner tests use {path} (matplotlib: {matplotlib})");
            Some(TestPython {
                path,
                env,
                matplotlib,
            })
        })
        .as_ref()
}

macro_rules! python_or_skip {
    () => {
        match test_python() {
            Some(python) => python,
            None => {
                eprintln!("SKIPPED: no Python 3 interpreter was found on this machine");
                return;
            }
        }
    };
}

macro_rules! matplotlib_or_skip {
    () => {{
        let python = python_or_skip!();
        if !python.matplotlib {
            eprintln!("SKIPPED: {} has no matplotlib", python.path);
            return;
        }
        python
    }};
}

/// What the Member does when the approval window opens.
#[derive(Clone, Copy, PartialEq)]
enum Answer {
    Run,
    DontRun,
    CloseWindow,
    /// Leaves the window open and does nothing.
    Nothing,
}

/// The app's windows with a Member in front of them.
struct Member<'a> {
    runner: &'a Runner,
    answer: Answer,
    /// What the approval window showed, each time it opened.
    shown: Mutex<Vec<Arc<ApprovalView>>>,
    closed: AtomicUsize,
    /// How often the settings window opened, and what the Member chooses in it.
    configured: AtomicUsize,
    choose: Option<String>,
}

impl<'a> Member<'a> {
    fn new(runner: &'a Runner, answer: Answer) -> Self {
        Self {
            runner,
            answer,
            shown: Mutex::default(),
            closed: AtomicUsize::new(0),
            configured: AtomicUsize::new(0),
            choose: None,
        }
    }

    fn asked(&self) -> usize {
        self.shown.lock().unwrap().len()
    }
}

impl Ui for Member<'_> {
    fn configure(&self, _cancel: &Cancel) {
        self.configured.fetch_add(1, Ordering::SeqCst);
        if let Some(path) = &self.choose {
            self.runner.settings_save(Some(path), None).unwrap();
        }
    }

    fn show_approval(&self, ticket: u64) -> bool {
        let view = self
            .runner
            .approval_view(ticket)
            .expect("a question is open");
        self.shown.lock().unwrap().push(view);
        match self.answer {
            Answer::Run => self.runner.approval_decide(ticket, true).unwrap(),
            Answer::DontRun => self.runner.approval_decide(ticket, false).unwrap(),
            Answer::CloseWindow => self.runner.approval_closed(ticket),
            Answer::Nothing => {}
        }
        true
    }

    fn close_approval(&self, _ticket: u64) {
        self.closed.fetch_add(1, Ordering::SeqCst);
    }
}

struct Bench {
    runner: Arc<Runner>,
    config: tempfile::TempDir,
    temp_root: tempfile::TempDir,
}

/// A Runner with its own config and temporary folders; `chosen`: the interpreter is
/// already chosen in the settings.
fn bench_with(python: &TestPython, chosen: bool, change: impl FnOnce(&mut Options)) -> Bench {
    let config = tempfile::tempdir().unwrap();
    let temp_root = tempfile::tempdir().unwrap();
    let mut options = Options::new(config.path());
    options.min_view = Duration::ZERO;
    options.temp_root = temp_root.path().to_owned();
    options.env = Some(python.env.clone());
    change(&mut options);
    let runner = Arc::new(Runner::new(options));
    if chosen {
        runner.settings_save(Some(&python.path), None).unwrap();
    }
    Bench {
        runner,
        config,
        temp_root,
    }
}

fn bench(python: &TestPython) -> Bench {
    bench_with(python, true, |_| {})
}

impl Bench {
    fn run_as(&self, member: &Member, origin: &str, code: &str) -> Vec<RunEvent> {
        let mut events = Vec::new();
        self.runner.run(
            RunRequest {
                id: "run-1".into(),
                code: code.to_owned(),
                title: "Test Run".into(),
                lang: None,
                env: None,
            },
            &Workspace {
                key: origin.to_owned(),
                name: origin.to_owned(),
            },
            member,
            &mut |e| events.push(e),
        );
        assert!(self.runner.is_idle());
        // Whatever happened, nothing is left in the temporary folder.
        assert_eq!(
            fs::read_dir(self.temp_root.path()).unwrap().count(),
            0,
            "the Run's temporary directory was not removed"
        );
        events
    }

    /// Runs `code` with a Member who approves it.
    fn run(&self, code: &str) -> Done {
        let member = Member::new(&self.runner, Answer::Run);
        done(self.run_as(&member, ORIGIN, code))
    }
}

#[derive(Debug)]
struct Done {
    exit: Option<i32>,
    stopped: bool,
    duration_ms: u64,
    code_sha256: String,
    output: String,
    output_truncated: bool,
    figures: Vec<Vec<u8>>,
    python: Option<String>,
    packages: Option<BTreeMap<String, String>>,
    os: Option<String>,
    arch: Option<String>,
    /// The `output` events, in order.
    streamed: Vec<String>,
    /// The `stats` events, in order.
    stats: Vec<Usage>,
    /// The types of all events, in order.
    kinds: Vec<&'static str>,
}

impl Done {
    /// The types of the events in order, without `stats` (a slow machine may get one in
    /// even for a short Run) and with what arrived in several pieces named once.
    fn order(&self) -> Vec<&'static str> {
        let mut kinds = self.kinds.clone();
        kinds.retain(|k| *k != "stats");
        kinds.dedup();
        kinds
    }
}

fn kind(event: &RunEvent) -> &'static str {
    match event {
        RunEvent::Approval => "approval",
        RunEvent::Started => "started",
        RunEvent::Output { .. } => "output",
        RunEvent::Stats(_) => "stats",
        RunEvent::Done { .. } => "done",
        RunEvent::Error { .. } => "error",
    }
}

fn done(events: Vec<RunEvent>) -> Done {
    let kinds: Vec<_> = events.iter().map(kind).collect();
    let streamed: Vec<String> = events
        .iter()
        .filter_map(|e| match e {
            RunEvent::Output { text } => Some(text.clone()),
            _ => None,
        })
        .collect();
    let stats: Vec<Usage> = events
        .iter()
        .filter_map(|e| match e {
            RunEvent::Stats(usage) => Some(usage.clone()),
            _ => None,
        })
        .collect();
    let Some(RunEvent::Done {
        lang: _,
        exit,
        stopped,
        duration_ms,
        code_sha256,
        output,
        output_truncated,
        figures,
        env,
    }) = events.into_iter().last()
    else {
        panic!("the Run did not end with `done`: {kinds:?}");
    };
    let figures = figures
        .iter()
        .map(|f| {
            assert!(f.png.len() <= 160_000, "a figure is over the limit");
            base64::engine::general_purpose::STANDARD
                .decode(&f.png)
                .expect("figures are base64")
        })
        .collect();
    Done {
        exit,
        stopped,
        duration_ms,
        code_sha256,
        output,
        output_truncated,
        figures,
        python: env.python,
        packages: env.packages,
        os: env.os,
        arch: env.arch,
        streamed,
        stats,
        kinds,
    }
}

fn failure(events: &[RunEvent]) -> (Reason, &str) {
    match events {
        [.., RunEvent::Error { reason, message }] => (*reason, message),
        other => panic!(
            "expected an error at the end: {:?}",
            other.iter().map(kind).collect::<Vec<_>>()
        ),
    }
}

/// Width and height from a PNG's header; panics if it is not a PNG.
fn png_size(data: &[u8]) -> (u32, u32) {
    assert!(data.starts_with(b"\x89PNG\r\n\x1a\n"), "not a PNG");
    assert_eq!(&data[12..16], b"IHDR");
    let number = |at: usize| u32::from_be_bytes(data[at..at + 4].try_into().unwrap());
    (number(16), number(20))
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only asks whether the process exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

fn wait_until_gone(pid: i32) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while alive(pid) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    !alive(pid)
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

// ---- approval ------------------------------------------------------------------------------

#[test]
fn hello_runs_after_the_member_approved_it() {
    let python = python_or_skip!();
    let bench = bench(python);
    let code = "print('hello from the Runner')\n";
    let member = Member::new(&bench.runner, Answer::Run);
    let run = done(bench.run_as(&member, ORIGIN, code));

    assert_eq!(run.order(), ["approval", "started", "output", "done"]);
    assert_eq!(run.output, "hello from the Runner\n");
    assert_eq!(run.streamed.concat(), run.output);
    assert_eq!(run.exit, Some(0));
    assert!(!run.stopped && !run.output_truncated);
    assert!(run.figures.is_empty());
    assert_eq!(run.code_sha256, inspect::sha256_hex(code));
    assert!(run.python.as_deref().unwrap().starts_with("3."));
    assert_eq!(run.packages, None);
    assert_eq!(run.os.as_deref(), Some(std::env::consts::OS));
    assert!(matches!(run.arch.as_deref(), Some("arm64" | "x86_64")));
    assert!(run.duration_ms < 60_000);

    // The window showed what was about to happen, and was closed afterwards.
    let shown = member.shown.lock().unwrap();
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0].title, "Test Run");
    assert_eq!(shown[0].origin, ORIGIN);
    assert_eq!(shown[0].program, python.path);
    assert_eq!(shown[0].lang, "python");
    assert_eq!(shown[0].folder, None);
    assert_eq!(shown[0].line_count, 1);
    assert_eq!(shown[0].sha256, run.code_sha256);
    assert_eq!(member.closed.load(Ordering::SeqCst), 1);
}

#[test]
fn nothing_runs_without_a_yes() {
    let python = python_or_skip!();
    let bench = bench(python);
    let proof = bench.config.path().join("it-ran");
    let code = format!(
        "open({:?}, 'w').close()\nprint('ran')\n",
        proof.to_str().unwrap()
    );

    for answer in [Answer::DontRun, Answer::CloseWindow] {
        let member = Member::new(&bench.runner, answer);
        let events = bench.run_as(&member, ORIGIN, &code);
        assert_eq!(
            events.iter().map(kind).collect::<Vec<_>>(),
            ["approval", "error"]
        );
        assert_eq!(
            failure(&events),
            (Reason::Declined, "You chose not to run this code.")
        );
        assert_eq!(member.asked(), 1);
        assert!(!proof.exists(), "declined code was executed");
    }

    // The Member leaves the window open; the page gives up (or goes away).
    let member = Member::new(&bench.runner, Answer::Nothing);
    let runner = bench.runner.clone();
    let stopper = thread::spawn(move || {
        thread::sleep(Duration::from_millis(300));
        runner.cancel("someone-elses-run"); // not this Run's id: nothing happens
        thread::sleep(Duration::from_millis(200));
        runner.cancel("run-1");
    });
    let started = Instant::now();
    let events = bench.run_as(&member, ORIGIN, &code);
    stopper.join().unwrap();
    assert!(started.elapsed() >= Duration::from_millis(450));
    assert_eq!(
        events.iter().map(kind).collect::<Vec<_>>(),
        ["approval", "error"]
    );
    assert_eq!(failure(&events).0, Reason::Declined);
    assert_eq!(
        member.closed.load(Ordering::SeqCst),
        1,
        "the window was left open"
    );
    assert!(!proof.exists());

    // None of that was remembered: it asks again, and a yes runs it.
    let member = Member::new(&bench.runner, Answer::Run);
    let run = done(bench.run_as(&member, ORIGIN, &code));
    assert_eq!(member.asked(), 1);
    assert_eq!(run.output, "ran\n");
    assert!(proof.exists());
}

#[test]
fn approved_code_runs_again_without_asking_and_changed_code_asks_again() {
    let python = python_or_skip!();
    let bench = bench(python);
    let code = "print(6 * 7)\n";
    let first = Member::new(&bench.runner, Answer::Run);
    assert_eq!(done(bench.run_as(&first, ORIGIN, code)).output, "42\n");
    assert_eq!(first.asked(), 1);

    // Same code, same server: no question (and nobody there who could answer).
    let nobody = Member::new(&bench.runner, Answer::Nothing);
    let again = done(bench.run_as(&nobody, ORIGIN, code));
    assert_eq!(again.order(), ["started", "output", "done"]);
    assert_eq!(again.output, "42\n");
    assert_eq!(nobody.asked(), 0);

    // Still remembered by a Runner started later over the same config folder.
    let mut options = Options::new(bench.config.path());
    options.env = Some(python.env.clone());
    options.temp_root = bench.temp_root.path().to_owned();
    let later = Runner::new(options);
    let nobody = Member::new(&later, Answer::Nothing);
    let mut events = Vec::new();
    later.run(
        RunRequest {
            id: "r".into(),
            code: code.into(),
            title: String::new(),
            lang: None,
            env: None,
        },
        &workspace(),
        &nobody,
        &mut |e| events.push(e),
    );
    assert_eq!(done(events).output, "42\n");
    assert_eq!(nobody.asked(), 0);

    // One changed character asks again; declined, it does not run.
    let member = Member::new(&bench.runner, Answer::DontRun);
    let events = bench.run_as(&member, ORIGIN, "print(6 * 8)\n");
    assert_eq!(failure(&events).0, Reason::Declined);
    assert_eq!(member.asked(), 1);

    // The same code from another server asks again.
    let member = Member::new(&bench.runner, Answer::DontRun);
    let events = bench.run_as(&member, "https://other.example.org", code);
    assert_eq!(failure(&events).0, Reason::Declined);
    assert_eq!(member.asked(), 1);
    assert_eq!(
        member.shown.lock().unwrap()[0].origin,
        "https://other.example.org"
    );

    // After "forget", the first code asks again too.
    bench.runner.forget_approvals().unwrap();
    let member = Member::new(&bench.runner, Answer::DontRun);
    assert_eq!(
        failure(&bench.run_as(&member, ORIGIN, code)).0,
        Reason::Declined
    );
    assert_eq!(member.asked(), 1);
}

#[test]
fn a_yes_that_comes_at_once_does_not_count() {
    let python = python_or_skip!();
    let bench = bench_with(python, true, |o| o.min_view = Duration::from_millis(400));

    /// A Member whose click lands the moment the window appears, then again later.
    struct Hasty<'a>(&'a Runner, Mutex<Vec<Result<(), DecideError>>>);
    impl Ui for Hasty<'_> {
        fn configure(&self, _: &Cancel) {}
        fn show_approval(&self, ticket: u64) -> bool {
            self.0.approval_view(ticket).unwrap();
            let first = self.0.approval_decide(ticket, true);
            thread::sleep(Duration::from_millis(450));
            let second = self.0.approval_decide(ticket, true);
            self.1.lock().unwrap().extend([first, second]);
            true
        }
        fn close_approval(&self, _: u64) {}
    }
    let member = Hasty(&bench.runner, Mutex::default());
    let mut events = Vec::new();
    bench.runner.run(
        RunRequest {
            id: "r".into(),
            code: "print('ok')".into(),
            title: String::new(),
            lang: None,
            env: None,
        },
        &workspace(),
        &member,
        &mut |e| events.push(e),
    );
    assert_eq!(
        *member.1.lock().unwrap(),
        [Err(DecideError::TooSoon), Ok(())]
    );
    assert_eq!(done(events).output, "ok\n");
}

#[test]
fn code_that_cannot_be_shown_is_refused_before_any_window() {
    let python = python_or_skip!();
    let bench = bench(python);
    let member = Member::new(&bench.runner, Answer::Run);
    for code in [
        String::new(),
        "  \n\n".to_owned(),
        format!("x = 1\n{}", "#".repeat(100_000)),
    ] {
        let events = bench.run_as(&member, ORIGIN, &code);
        assert_eq!(events.len(), 1);
        assert_eq!(failure(&events).0, Reason::Failed);
    }
    assert_eq!(member.asked(), 0);
    // Exactly at the limit is fine.
    let code = format!("print('big')\n{}", "#".repeat(100_000 - 13));
    assert_eq!(code.chars().count(), 100_000);
    assert_eq!(done(bench.run_as(&member, ORIGIN, &code)).output, "big\n");

    // A request without a usable id is refused too.
    for id in ["", "a\nb"] {
        let mut events = Vec::new();
        bench.runner.run(
            RunRequest {
                id: id.into(),
                code: "print(1)".into(),
                title: String::new(),
                lang: None,
                env: None,
            },
            &workspace(),
            &member,
            &mut |e| events.push(e),
        );
        assert_eq!(failure(&events).0, Reason::Failed);
    }
}

#[test]
fn an_encoding_declaration_cannot_change_what_runs() {
    let python = python_or_skip!();
    let bench = bench(python);
    // Read as UTF-7, the second line would end the comment and call print(). The Member is
    // shown a comment; a comment is what runs.
    let code =
        "# -*- coding: utf-7 -*-\n# +AAo-print('hidden code ran')\nprint('visible code ran')\n";
    let member = Member::new(&bench.runner, Answer::Run);
    let run = done(bench.run_as(&member, ORIGIN, code));
    assert_eq!(run.output, "visible code ran\n");
    assert_eq!(member.shown.lock().unwrap()[0].line_count, 3);
}

// ---- settings ------------------------------------------------------------------------------

#[test]
fn the_first_run_without_a_chosen_python_opens_the_settings() {
    let python = python_or_skip!();
    let bench = bench_with(python, false, |_| {});
    assert_eq!(bench.runner.status().python, None);

    // The Member closes the settings without choosing.
    let member = Member::new(&bench.runner, Answer::Run);
    let events = bench.run_as(&member, ORIGIN, "print(1)");
    assert_eq!(events.len(), 1);
    assert_eq!(failure(&events).0, Reason::NoPython);
    assert_eq!(member.configured.load(Ordering::SeqCst), 1);
    assert_eq!(member.asked(), 0);

    // The Member chooses one: the Run goes on to the approval, and runs.
    let mut member = Member::new(&bench.runner, Answer::Run);
    member.choose = Some(python.path.clone());
    let run = done(bench.run_as(&member, ORIGIN, "print(1)"));
    assert_eq!(run.order(), ["approval", "started", "output", "done"]);
    assert_eq!(member.configured.load(Ordering::SeqCst), 1);
    let status = bench.runner.status();
    assert_eq!(status.python.as_ref().unwrap().path, python.path);
    assert!(status.python.unwrap().version.starts_with("3."));
    assert_eq!(status.folder, None);

    // From then on the settings are not opened again.
    let member = Member::new(&bench.runner, Answer::Run);
    done(bench.run_as(&member, ORIGIN, "print(2)"));
    assert_eq!(member.configured.load(Ordering::SeqCst), 0);

    // A chosen interpreter that has since disappeared counts as not chosen.
    let gone = bench.config.path().join("python-gone");
    fs::write(&gone, "#!/bin/sh\necho 'Python 3.11.0'\n").unwrap();
    fs::set_permissions(&gone, fs::Permissions::from_mode(0o755)).unwrap();
    bench
        .runner
        .settings_save(Some(gone.to_str().unwrap()), None)
        .unwrap();
    assert_eq!(bench.runner.status().python.unwrap().version, "3.11.0");
    fs::remove_file(&gone).unwrap();
    assert_eq!(bench.runner.status().python, None);
    let member = Member::new(&bench.runner, Answer::Run);
    assert_eq!(
        failure(&bench.run_as(&member, ORIGIN, "print(3)")).0,
        Reason::NoPython
    );
}

#[test]
fn settings_accept_only_python_3_and_existing_folders() {
    let python = python_or_skip!();
    let bench = bench(python);
    let runner = &bench.runner;
    let dir = bench.config.path();
    let not_python = dir.join("not-python");
    fs::write(&not_python, "#!/bin/sh\necho 'Ruby 3.3'\n").unwrap();
    fs::set_permissions(&not_python, fs::Permissions::from_mode(0o755)).unwrap();

    assert!(
        runner
            .settings_save(Some(not_python.to_str().unwrap()), None)
            .is_err()
    );
    assert!(runner.settings_save(Some("python3"), None).is_err());
    assert!(
        runner
            .settings_save(Some(&python.path), Some("/no/such/folder"))
            .is_err()
    );
    assert!(
        runner
            .settings_save(Some(&python.path), Some("relative"))
            .is_err()
    );
    // A refused save changes nothing.
    assert_eq!(runner.status().python.unwrap().path, python.path);
    assert_eq!(runner.status().folder, None);

    runner
        .settings_save(Some(&python.path), Some(dir.to_str().unwrap()))
        .unwrap();
    assert_eq!(runner.status().folder.as_deref(), dir.to_str());
    // Clearing both is a valid choice.
    runner.settings_save(None, Some("  ")).unwrap();
    assert_eq!(runner.status().python, None);
    assert_eq!(runner.status().folder, None);

    // The real lookup finds the interpreter the tests use (unless it was named by hand).
    if std::env::var_os("QOOP_TEST_PYTHON").is_none() {
        let view = runner.settings_view(true);
        assert!(
            view.found.iter().any(|i| i.path == python.path),
            "{:?}",
            view.found
        );
        assert!(view.found.iter().all(|i| i.version.starts_with("3.")));
        let mut paths: Vec<_> = view.found.iter().map(|i| &i.path).collect();
        paths.sort();
        paths.dedup();
        assert_eq!(
            paths.len(),
            view.found.len(),
            "an interpreter is listed twice"
        );
        assert_eq!(view.overridden, None);
    }
}

#[test]
fn the_override_chooses_the_interpreter_but_never_the_approval() {
    let python = python_or_skip!();
    let bench = bench_with(python, false, |o| {
        o.python_override = Some(PathBuf::from(&python.path))
    });
    assert_eq!(bench.runner.status().python.unwrap().path, python.path);
    let member = Member::new(&bench.runner, Answer::DontRun);
    let events = bench.run_as(&member, ORIGIN, "print(1)");
    assert_eq!(failure(&events).0, Reason::Declined);
    assert_eq!(member.asked(), 1);
    assert_eq!(member.configured.load(Ordering::SeqCst), 0);

    // An override that is not Python: no Run, no settings window, no question.
    let bench = bench_with(python, true, |o| {
        o.python_override = Some(PathBuf::from("/bin/echo"))
    });
    assert_eq!(bench.runner.status().python, None);
    let member = Member::new(&bench.runner, Answer::Run);
    let events = bench.run_as(&member, ORIGIN, "print(1)");
    assert_eq!(failure(&events).0, Reason::Failed);
    assert_eq!(member.asked() + member.configured.load(Ordering::SeqCst), 0);
}

#[test]
fn the_chosen_folder_is_where_the_code_runs() {
    let python = python_or_skip!();
    let bench = bench(python);
    let folder = tempfile::tempdir().unwrap();
    let folder_path = folder.path().canonicalize().unwrap();
    fs::write(
        folder_path.join("mymodule.py"),
        "VALUE = 'from my own module'\n",
    )
    .unwrap();
    fs::write(folder_path.join("data.txt"), "my data").unwrap();
    // A file of the same name as the Run's own must not be touched or executed.
    fs::write(folder_path.join("main.py"), "print('the wrong main.py')\n").unwrap();
    bench
        .runner
        .settings_save(Some(&python.path), folder_path.to_str())
        .unwrap();

    let code = "import os, sys\nimport mymodule\nprint(mymodule.VALUE)\nprint(open('data.txt').read())\nprint(os.getcwd())\nprint(sys.path[0])\nprint(os.path.dirname(__file__) == os.environ['QOOP_RUN_DIR'])\n1/0\n";
    let member = Member::new(&bench.runner, Answer::Run);
    let run = done(bench.run_as(&member, ORIGIN, code));
    let cwd = folder_path.to_str().unwrap();
    assert!(
        run.output.starts_with(&format!(
            "from my own module\nmy data\n{cwd}\n{cwd}\nTrue\n"
        )),
        "{}",
        run.output
    );
    // The traceback quotes the Run's line 8, not line 8 of the folder's main.py.
    assert!(
        run.output
            .contains("File \"main.py\", line 8, in <module>\n    1/0\n"),
        "{}",
        run.output
    );
    assert_eq!(member.shown.lock().unwrap()[0].folder.as_deref(), Some(cwd));
    assert_eq!(
        fs::read_to_string(folder_path.join("main.py")).unwrap(),
        "print('the wrong main.py')\n"
    );
    // Nothing of the Runner's own is left in the Member's folder.
    let mut names: Vec<_> = fs::read_dir(&folder_path)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|n| n != "__pycache__")
        .collect();
    names.sort();
    assert_eq!(names, ["data.txt", "main.py", "mymodule.py"]);

    // The folder disappears: the Run is refused, not run somewhere else.
    drop(folder);
    let events = bench.run_as(&member, ORIGIN, code);
    assert_eq!(failure(&events).0, Reason::Failed);
}

// ---- execution -----------------------------------------------------------------------------

#[test]
fn the_code_runs_as_main_from_a_private_file() {
    let python = python_or_skip!();
    let bench = bench(python);
    let code = r#"import os, stat, sys
run_dir = os.environ['QOOP_RUN_DIR']
print(__name__)
print(os.path.basename(__file__), os.path.dirname(__file__) == run_dir)
print(os.getcwd() == run_dir, sys.path[0] == run_dir)
print(oct(stat.S_IMODE(os.stat(run_dir).st_mode)))
print(sorted((name, oct(stat.S_IMODE(os.stat(os.path.join(run_dir, name)).st_mode))) for name in os.listdir(run_dir)))
print(sys.argv == [__file__])
print(os.environ['MPLBACKEND'], os.environ['PYTHONUNBUFFERED'], os.environ['PYTHONIOENCODING'])
print(sys.stdin.read() == '')
print(os.getpgrp() == os.getpid())
SECRET_MARKER = 'only-in-the-file-7f3a'
argv = getattr(sys, 'orig_argv', None)
print('code on the command line:', None if argv is None else any('only-in-the-file' in a for a in argv))
print('arguments:', None if argv is None else [os.path.basename(a) for a in argv])
print(run_dir)
"#;
    let run = bench.run(code);
    assert_eq!(run.exit, Some(0), "{}", run.output);
    let lines: Vec<&str> = run.output.lines().collect();
    assert_eq!(lines[0], "__main__");
    assert_eq!(lines[1], "main.py True");
    assert_eq!(lines[2], "True True");
    assert_eq!(lines[3], "0o700");
    assert_eq!(lines[4], "[('main.py', '0o600'), ('runner.py', '0o600')]");
    assert_eq!(lines[5], "True");
    assert_eq!(lines[6], "Agg 1 utf-8");
    assert_eq!(lines[7], "True");
    assert_eq!(lines[8], "True", "the process does not lead its own group");
    assert!(
        lines[9] == "code on the command line: False"
            || lines[9] == "code on the command line: None",
        "{}",
        lines[9]
    );
    if lines[10] != "arguments: None" {
        assert!(
            lines[10].ends_with("'-u', '-X', 'utf8', 'runner.py', 'main.py']"),
            "{}",
            lines[10]
        );
    }
    let run_dir = Path::new(lines[11]);
    assert!(run_dir.starts_with(bench.temp_root.path().canonicalize().unwrap()));
    assert!(!run_dir.exists(), "the temporary directory is still there");
}

#[test]
fn packages_usage_reports_are_off_in_every_run_whatever_the_shell_says() {
    let python = python_or_skip!();
    // The Member's login shell turned qdk's reporting on, and set something of its own.
    let bench = bench_with(python, true, |o| {
        let env = o.env.get_or_insert_with(Vec::new);
        env.retain(|(k, _)| k != "QDK_PYTHON_TELEMETRY");
        env.push(("QDK_PYTHON_TELEMETRY".into(), "on".into()));
        env.push(("QOOP_TEST_OWN".into(), "kept".into()));
    });
    let code = r#"import os
for name in ['QDK_PYTHON_TELEMETRY', 'QSHARP_PYTHON_TELEMETRY', 'HF_HUB_DISABLE_TELEMETRY', 'MLFLOW_DISABLE_TELEMETRY', 'QOOP_TEST_OWN']:
    print(name, os.environ.get(name))
"#;
    let run = bench.run(code);
    assert_eq!(run.exit, Some(0), "{}", run.output);
    assert_eq!(
        run.output,
        "QDK_PYTHON_TELEMETRY none\nQSHARP_PYTHON_TELEMETRY none\nHF_HUB_DISABLE_TELEMETRY 1\nMLFLOW_DISABLE_TELEMETRY true\nQOOP_TEST_OWN kept\n"
    );
    // The list the Runner sets is exactly these.
    assert_eq!(
        qoop_runner::exec::NO_USAGE_REPORTS,
        [
            ("QDK_PYTHON_TELEMETRY", "none"),
            ("QSHARP_PYTHON_TELEMETRY", "none"),
            ("HF_HUB_DISABLE_TELEMETRY", "1"),
            ("MLFLOW_DISABLE_TELEMETRY", "true"),
        ]
    );
}

#[test]
fn standard_output_and_standard_error_keep_their_order() {
    let python = python_or_skip!();
    let code = r#"import sys, os
for n in range(30):
    print('out', n)
    print('err', n, file=sys.stderr)
os.write(1, b'raw out\n')
os.write(2, b'raw err\n')
sys.stdout.write('no newline at the end')
"#;
    let run = bench(python).run(code);
    let mut expected = String::new();
    for n in 0..30 {
        expected.push_str(&format!("out {n}\nerr {n}\n"));
    }
    expected.push_str("raw out\nraw err\nno newline at the end");
    assert_eq!(run.output, expected);
    assert_eq!(run.streamed.concat(), expected);
}

#[test]
fn exit_codes() {
    let python = python_or_skip!();
    let bench = bench(python);
    let run = bench.run("print('fine')");
    assert_eq!((run.exit, run.output.as_str()), (Some(0), "fine\n"));
    let run = bench.run("import sys\nprint('before')\nsys.exit(3)\nprint('never')");
    assert_eq!((run.exit, run.output.as_str()), (Some(3), "before\n"));
    let run = bench.run("import sys\nsys.exit()");
    assert_eq!((run.exit, run.output.as_str()), (Some(0), ""));
    let run = bench.run("raise SystemExit(0)");
    assert_eq!(run.exit, Some(0));
    // A message instead of a number: printed, exit code 1 (as Python itself does).
    let run = bench.run("import sys\nsys.exit('giving up: no data')");
    assert_eq!(
        (run.exit, run.output.as_str()),
        (Some(1), "giving up: no data\n")
    );
    let run = bench.run("exit(42)");
    assert_eq!(run.exit, Some(42));
    // SystemExit from inside a function, through a finally.
    let run = bench.run("def f():\n    try:\n        raise SystemExit(9)\n    finally:\n        print('cleanup')\nf()");
    assert_eq!((run.exit, run.output.as_str()), (Some(9), "cleanup\n"));
    // Leaving without the interpreter's own shutdown.
    let run = bench.run("import os\nprint('gone', flush=True)\nos._exit(7)");
    assert_eq!((run.exit, run.output.as_str()), (Some(7), "gone\n"));
    assert!(!run.stopped);
    // An exit handler still runs, after the code.
    let run = bench.run("import atexit\natexit.register(lambda: print('at exit'))\nprint('main')\nraise SystemExit(4)");
    assert_eq!(
        (run.exit, run.output.as_str()),
        (Some(4), "main\nat exit\n")
    );
}

#[test]
fn a_process_killed_by_a_signal_has_no_exit_code() {
    let python = python_or_skip!();
    let run = bench(python).run("import os, signal\nprint('about to die', flush=True)\nos.kill(os.getpid(), signal.SIGKILL)");
    assert_eq!(run.exit, None);
    assert!(!run.stopped);
    assert_eq!(
        run.output,
        "about to die\n\n[qoop] The process was ended by signal 9.\n"
    );
    assert!(run.figures.is_empty());
}

#[test]
fn tracebacks_name_main_py_with_the_right_lines() {
    let python = python_or_skip!();
    let bench = bench(python);
    let code = "import math\n\ndef ratio(a, b):\n    return a / b\n\nprint('start')\nvalue = ratio(1, 0)\nprint('never')\n";
    let run = bench.run(code);
    assert_eq!(run.exit, Some(1));
    assert!(
        run.output
            .starts_with("start\nTraceback (most recent call last):\n"),
        "{}",
        run.output
    );
    assert!(
        run.output
            .contains("  File \"main.py\", line 7, in <module>\n    value = ratio(1, 0)\n"),
        "{}",
        run.output
    );
    assert!(
        run.output
            .contains("  File \"main.py\", line 4, in ratio\n    return a / b\n"),
        "{}",
        run.output
    );
    assert!(
        run.output
            .trim_end()
            .ends_with("ZeroDivisionError: division by zero"),
        "{}",
        run.output
    );
    // Nothing of the Runner's own shows.
    assert!(
        !run.output.contains("runner.py") && !run.output.contains("qoop"),
        "{}",
        run.output
    );
    assert!(!run.output.contains("never"));

    // A syntax error: reported with its line, nothing executed.
    let run = bench.run("print('never')\nx = 1\ny = = 2\nprint('never either')\n");
    assert_eq!(run.exit, Some(1));
    assert!(
        run.output.contains("File \"main.py\", line 3"),
        "{}",
        run.output
    );
    assert!(run.output.contains("SyntaxError"), "{}", run.output);
    assert!(run.output.contains("y = = 2"), "{}", run.output);
    assert!(
        !run.output.contains("never\n") && !run.output.contains("runner.py"),
        "{}",
        run.output
    );

    // Lines ended with \r\n or \r count as Python counts them.
    let run = bench.run("a = 1\r\nb = 2\rraise ValueError('line three')\r\n");
    assert!(
        run.output.contains("File \"main.py\", line 3, in <module>"),
        "{}",
        run.output
    );
    assert!(
        run.output.contains("ValueError: line three"),
        "{}",
        run.output
    );

    // An exception raised while handling another shows both, both in main.py.
    let run = bench.run("try:\n    {}['k']\nexcept KeyError:\n    raise RuntimeError('second')\n");
    assert!(
        run.output.contains("File \"main.py\", line 2, in <module>"),
        "{}",
        run.output
    );
    assert!(
        run.output.contains("File \"main.py\", line 4, in <module>"),
        "{}",
        run.output
    );
    assert!(run.output.contains("RuntimeError: second"));

    // Ctrl-C raised by the code itself, and an exception whose text cannot be made.
    let run = bench.run("raise KeyboardInterrupt");
    assert_eq!(run.exit, Some(1));
    assert!(run.output.contains("KeyboardInterrupt"), "{}", run.output);
    let run = bench.run("class Odd(Exception):\n    def __str__(self):\n        raise RuntimeError('no text')\nprint('shown')\nraise Odd()\n");
    assert_eq!(run.exit, Some(1));
    assert!(run.output.starts_with("shown\n"), "{}", run.output);
    assert!(
        run.output.contains("File \"main.py\", line 5"),
        "{}",
        run.output
    );

    // The code's own excepthook is used.
    let run = bench.run("import sys\nsys.excepthook = lambda kind, value, tb: print('my hook:', kind.__name__, tb.tb_lineno)\nraise ValueError('x')\n");
    assert_eq!(
        (run.exit, run.output.as_str()),
        (Some(1), "my hook: ValueError 3\n")
    );
}

#[test]
fn unicode_in_code_and_output() {
    let python = python_or_skip!();
    let code = "größe = 'naïve café — 世界 🙂 مرحبا'\nprint(größe)\nprint(len(größe))\nimport sys\nprint('stderr: ñ', file=sys.stderr)\nprint(sys.stdout.encoding.lower(), sys.getfilesystemencoding())\n";
    let member_bench = bench(python);
    let run = member_bench.run(code);
    assert_eq!(
        run.output,
        "naïve café — 世界 🙂 مرحبا\n23\nstderr: ñ\nutf-8 utf-8\n"
    );
    assert_eq!(run.code_sha256, inspect::sha256_hex(code));

    // Bytes that are not UTF-8 do not break anything: they become U+FFFD.
    let run = member_bench.run("import sys\nsys.stdout.buffer.write(b'caf\\xe9 \\xff\\xfe ok\\n')\nsys.stdout.buffer.write('€'.encode()[:2])\n");
    assert_eq!(run.exit, Some(0));
    assert_eq!(run.output, "caf\u{fffd} \u{fffd}\u{fffd} ok\n\u{fffd}");

    // A multi-byte character written one byte at a time, with pauses, arrives whole.
    let run = member_bench.run("import os, time\nfor b in '🙂é'.encode():\n    os.write(1, bytes([b]))\n    time.sleep(0.03)\n");
    assert_eq!(run.output, "🙂é");
    assert_eq!(run.streamed.concat(), "🙂é");
}

#[test]
fn long_output_keeps_its_beginning_and_end() {
    let python = python_or_skip!();
    let bench = bench(python);
    let run = bench.run("for n in range(30000):\n    print('line', n)\n");
    assert_eq!(run.exit, Some(0));
    assert!(run.output_truncated);
    assert!(
        utf16_len(&run.output) <= 64_000,
        "{}",
        utf16_len(&run.output)
    );
    assert!(utf16_len(&run.output) > 63_000);
    assert!(run.output.starts_with("line 0\nline 1\nline 2\n"));
    assert!(run.output.ends_with("line 29998\nline 29999\n"));
    let markers: Vec<&str> = run
        .output
        .lines()
        .filter(|l| l.starts_with("[… "))
        .collect();
    assert_eq!(markers.len(), 1, "{markers:?}");
    assert!(markers[0].ends_with("characters of output are not shown …]"));
    // What was sent while it ran is bounded as well.
    assert!(run.streamed.iter().all(|t| utf16_len(t) <= 16_200));

    // Just under the limit: kept whole.
    let run = bench.run("import sys\nsys.stdout.write('x' * 63999 + '\\n')\n");
    assert!(!run.output_truncated);
    assert_eq!(run.output.len(), 64_000);

    // Characters outside the basic plane count double, and are never cut in half.
    let run = bench.run("import sys\nsys.stdout.write('🙂' * 40000)\n");
    assert!(run.output_truncated);
    assert!(utf16_len(&run.output) <= 64_000);
    assert!(run.output.starts_with("🙂🙂") && run.output.ends_with("🙂🙂"));
    assert!(!run.output.contains('\u{fffd}'));

    // A flood far beyond anything kept ends, and ends bounded.
    let run = bench.run("import sys\nchunk = 'y' * 65536\nfor _ in range(600):\n    sys.stdout.write(chunk)\nprint('\\nthe end')\n");
    assert_eq!(run.exit, Some(0));
    assert!(run.output_truncated && utf16_len(&run.output) <= 64_000);
    assert!(run.output.ends_with("\nthe end\n"));
}

#[test]
fn output_arrives_while_the_code_runs_about_ten_times_a_second() {
    let python = python_or_skip!();
    let bench = bench(python);
    let member = Member::new(&bench.runner, Answer::Run);
    let mut arrivals: Vec<(Instant, String)> = Vec::new();
    let mut ended = None;
    bench.runner.run(
        RunRequest {
            id: "r".into(),
            code: "import time\nfor n in range(100):\n    print(n)\n    time.sleep(0.015)\n".into(),
            title: String::new(),
            lang: None,
            env: None,
        },
        &workspace(),
        &member,
        &mut |e| match e {
            RunEvent::Output { text } => arrivals.push((Instant::now(), text)),
            RunEvent::Done { output, .. } => ended = Some((Instant::now(), output)),
            _ => {}
        },
    );
    let (end, output) = ended.expect("done");
    let expected: String = (0..100).map(|n| format!("{n}\n")).collect();
    assert_eq!(output, expected);
    assert_eq!(
        arrivals.iter().map(|(_, t)| t.as_str()).collect::<String>(),
        expected
    );
    // 100 prints over about 1.5 s: far fewer events than prints, but a steady stream.
    assert!(
        arrivals.len() >= 5 && arrivals.len() <= 40,
        "{} events",
        arrivals.len()
    );
    for pair in arrivals.windows(2) {
        // (The very last event may follow sooner: it carries what was left at the end.)
        let gap = pair[1].0.duration_since(pair[0].0);
        assert!(
            gap >= Duration::from_millis(90) || pair[1].0 == arrivals.last().unwrap().0,
            "{gap:?}"
        );
    }
    // The first output reached the page long before the end.
    assert!(end.duration_since(arrivals[0].0) > Duration::from_millis(700));
}

#[test]
fn a_weird_program_cannot_hide_its_output_or_exit_code() {
    let python = python_or_skip!();
    let bench = bench(python);
    // Closes its own standard streams, deletes the Run's directory, then exits with 5.
    let run = bench.run("import os, shutil, sys\nprint('before')\nsys.stdout.close()\nsys.stderr = None\nshutil.rmtree(os.environ['QOOP_RUN_DIR'], ignore_errors=True)\nraise SystemExit(5)\n");
    assert_eq!((run.exit, run.output.as_str()), (Some(5), "before\n"));
    assert!(run.python.as_deref().unwrap().starts_with("3."));

    // Replaces the modules the Runner's own program would use afterwards.
    let run = bench.run("import sys\nprint('still here')\nfor name in ('os', 'json', 'ast', 'importlib', 'importlib.metadata', 'warnings'):\n    sys.modules[name] = None\nsys.modules['matplotlib.pyplot'] = object()\nraise SystemExit(6)\n");
    assert_eq!(run.exit, Some(6));
    assert!(run.output.starts_with("still here\n"), "{}", run.output);
    assert!(run.figures.is_empty());

    // Plants its own description of the Run, with a "figure" that is a link to a file
    // elsewhere, and leaves before the Runner's program can write the real one.
    let outside = bench.config.path().join("private.png");
    fs::write(&outside, b"\x89PNG\r\n\x1a\nprivate bytes").unwrap();
    let code = format!(
        "import json, os\nd = os.environ['QOOP_RUN_DIR']\nos.symlink({:?}, os.path.join(d, 'qoop-figure-1.png'))\njson.dump({{'python': '9.9.9', 'packages': [['evil', '1']], 'figures': ['qoop-figure-1.png', '../x.png']}}, open(os.path.join(d, 'qoop-env.json'), 'w'))\nprint('planted', flush=True)\nos._exit(0)\n",
        outside.to_str().unwrap()
    );
    let run = bench.run(&code);
    assert_eq!((run.exit, run.output.as_str()), (Some(0), "planted\n"));
    assert!(
        run.figures.is_empty(),
        "a link out of the Run's directory was followed"
    );
    // (What a program says about itself is its own claim, like its output.)
    assert_eq!(run.python.as_deref(), Some("9.9.9"));

    // Deep recursion and a very large structure do not take the Runner's program down.
    let run = bench.run("import sys\nsys.setrecursionlimit(50)\ndef f(n):\n    return f(n + 1)\nprint('go')\nf(0)\n");
    assert_eq!(run.exit, Some(1));
    assert!(run.output.contains("RecursionError"), "{}", run.output);
}

// ---- stopping ------------------------------------------------------------------------------

/// Runs `code` on another thread, calls `during` once the output contains `marker`, and
/// returns the finished Run.
fn run_and_interrupt(
    bench: &Bench,
    code: &str,
    marker: &str,
    during: impl FnOnce(&Runner, &str),
) -> Done {
    let seen = Arc::new(Mutex::new(String::new()));
    let runner = bench.runner.clone();
    let code = code.to_owned();
    let collected = seen.clone();
    let worker = thread::spawn(move || {
        let member = Member::new(&runner, Answer::Run);
        let mut events = Vec::new();
        runner.run(
            RunRequest {
                id: "long-run".into(),
                code,
                title: "Long".into(),
                lang: None,
                env: None,
            },
            &workspace(),
            &member,
            &mut |e| {
                if let RunEvent::Output { text } = &e {
                    collected.lock().unwrap().push_str(text);
                }
                events.push(e);
            },
        );
        events
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let text = seen.lock().unwrap().clone();
        if text.contains(marker) {
            during(&bench.runner, &text);
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the code never printed {marker:?}: {text:?}"
        );
        assert!(
            !worker.is_finished(),
            "the Run ended before printing {marker:?}: {text:?}"
        );
        thread::sleep(Duration::from_millis(20));
    }
    done(worker.join().unwrap())
}

fn pids(output: &str) -> Vec<i32> {
    output
        .lines()
        .filter_map(|l| l.strip_prefix("pid "))
        .map(|p| p.trim().parse().unwrap())
        .collect()
}

#[test]
fn cancel_kills_the_whole_process_group() {
    let python = python_or_skip!();
    let bench = bench(python);
    // The code starts a child of its own, which starts a grandchild.
    let code = r#"import os, subprocess, sys, time
print('pid', os.getpid())
child = subprocess.Popen([sys.executable, '-c', 'import subprocess, time, os; g = subprocess.Popen(["sleep", "600"]); print("pid", os.getpid()); print("pid", g.pid, flush=True); time.sleep(600)'])
time.sleep(1.0)
print('ready', flush=True)
time.sleep(600)
print('never')
"#;
    let mut started_pids = Vec::new();
    let begun = Instant::now();
    let run = run_and_interrupt(&bench, code, "ready", |runner, output| {
        started_pids = pids(output);
        assert_eq!(started_pids.len(), 3, "{output}");
        assert!(started_pids.iter().all(|p| alive(*p)));
        assert!(!runner.is_idle());
        runner.cancel("long-run");
    });
    assert!(begun.elapsed() < Duration::from_secs(20));
    assert!(run.stopped);
    assert_eq!(run.exit, None);
    assert!(run.figures.is_empty());
    assert_eq!(run.kinds.last(), Some(&"done"));
    // What was printed before the stop is kept.
    assert!(
        run.output.contains("ready\n") && !run.output.contains("never"),
        "{}",
        run.output
    );
    assert_eq!(pids(&run.output), started_pids);
    assert!(run.python.as_deref().unwrap().starts_with("3."));
    for pid in started_pids {
        assert!(wait_until_gone(pid), "process {pid} survived the cancel");
    }
    assert!(bench.runner.is_idle());
}

#[test]
fn a_program_that_ignores_the_polite_request_is_killed() {
    let python = python_or_skip!();
    let bench = bench_with(python, true, |o| o.kill_grace = Duration::from_millis(300));
    let code = "import os, signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nprint('pid', os.getpid())\nprint('ready', flush=True)\nwhile True:\n    time.sleep(1)\n";
    let mut pid = 0;
    let begun = Instant::now();
    let run = run_and_interrupt(&bench, code, "ready", |runner, output| {
        pid = pids(output)[0];
        runner.cancel_all();
    });
    assert!(run.stopped && run.exit.is_none());
    assert!(begun.elapsed() < Duration::from_secs(15));
    assert!(wait_until_gone(pid));
}

#[test]
fn what_the_code_left_running_ends_with_it() {
    let python = python_or_skip!();
    let bench = bench(python);
    // The code ends normally but leaves a background process that keeps the output open.
    let code = "import os, subprocess\nchild = subprocess.Popen(['sleep', '600'])\nprint('pid', child.pid)\nprint('main is done')\n";
    let begun = Instant::now();
    let run = bench.run(code);
    assert!(
        begun.elapsed() < Duration::from_secs(15),
        "the Run waited for the background process"
    );
    assert_eq!(run.exit, Some(0));
    assert!(!run.stopped);
    assert!(run.output.ends_with("main is done\n"));
    assert!(
        wait_until_gone(pids(&run.output)[0]),
        "the background process survived"
    );
}

#[test]
fn one_run_at_a_time() {
    let python = python_or_skip!();
    let bench = bench(python);
    let code = "import time\nprint('ready', flush=True)\ntime.sleep(600)\n";
    let run = run_and_interrupt(&bench, code, "ready", |runner, _| {
        // A second Run while the first is in progress: refused, without any window.
        let member = Member::new(runner, Answer::Run);
        let mut events = Vec::new();
        runner.run(
            RunRequest {
                id: "second".into(),
                code: "print('second')".into(),
                title: String::new(),
                lang: None,
                env: None,
            },
            &workspace(),
            &member,
            &mut |e| events.push(e),
        );
        assert_eq!(events.len(), 1);
        assert_eq!(failure(&events).0, Reason::Busy);
        assert_eq!(member.asked(), 0);
        // Cancelling the refused Run's id does not touch the one in progress.
        runner.cancel("second");
        thread::sleep(Duration::from_millis(200));
        assert!(!runner.is_idle());
        runner.cancel("long-run");
    });
    assert!(run.stopped);
    assert_eq!(run.output, "ready\n");
    // And afterwards the Runner is free again.
    assert_eq!(bench.run("print('next')").output, "next\n");
}

#[test]
fn a_run_asked_for_right_after_a_cancel_waits_for_the_old_one_to_go() {
    let python = python_or_skip!();
    // The old program takes a moment to die: it ignores the polite request.
    let bench = bench_with(python, true, |o| o.kill_grace = Duration::from_millis(400));
    let code = "import signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nprint('ready', flush=True)\ntime.sleep(600)\n";
    let mut next = None;
    let old = run_and_interrupt(&bench, code, "ready", |runner, _| {
        // What a reloading page does: the app cancels, the new page asks at once.
        runner.cancel_all();
        let member = Member::new(runner, Answer::Run);
        let mut events = Vec::new();
        runner.run(
            RunRequest {
                id: "next".into(),
                code: "print('next')".into(),
                title: String::new(),
                lang: None,
                env: None,
            },
            &workspace(),
            &member,
            &mut |e| events.push(e),
        );
        next = Some(done(events));
    });
    assert!(old.stopped);
    assert_eq!(next.expect("the next Run").output, "next\n");
}

#[test]
fn a_run_is_busy_from_the_moment_it_waits_for_approval() {
    let python = python_or_skip!();
    let bench = bench(python);
    let runner = bench.runner.clone();
    let first = thread::spawn(move || {
        let member = Member::new(&runner, Answer::Nothing);
        let mut events = Vec::new();
        runner.run(
            RunRequest {
                id: "waiting".into(),
                code: "print('a')".into(),
                title: String::new(),
                lang: None,
                env: None,
            },
            &workspace(),
            &member,
            &mut |e| events.push(e),
        );
        events
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    while bench.runner.is_idle() {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(10));
    }
    thread::sleep(Duration::from_millis(100));
    let member = Member::new(&bench.runner, Answer::Run);
    let mut events = Vec::new();
    bench.runner.run(
        RunRequest {
            id: "other".into(),
            code: "print('b')".into(),
            title: String::new(),
            lang: None,
            env: None,
        },
        &workspace(),
        &member,
        &mut |e| events.push(e),
    );
    assert_eq!(failure(&events).0, Reason::Busy);
    assert_eq!(member.asked(), 0);
    bench.runner.cancel_all();
    let events = first.join().unwrap();
    assert_eq!(failure(&events).0, Reason::Declined);
}

// ---- the monitor ---------------------------------------------------------------------------

/// A step, and done of total.
type Said<'a> = (Option<&'a str>, Option<(f64, f64)>);

/// What the code said in each sample, with samples that say the same as the one before
/// left out.
fn said(stats: &[Usage]) -> Vec<Said<'_>> {
    let mut all: Vec<_> = stats
        .iter()
        .map(|u| (u.step.as_deref(), u.progress.map(|p| (p.done, p.total))))
        .collect();
    all.dedup();
    all
}

/// Every sample has the fields that are always there, with values that can be true.
fn assert_plausible(stats: &[Usage]) {
    for usage in stats {
        assert!(usage.processes >= 1, "{usage:?}");
        assert!(usage.cores >= 1, "{usage:?}");
        assert!(
            usage.cpu_percent >= 0.0 && usage.cpu_percent <= 100.0 * f64::from(usage.cores) + 50.0,
            "{usage:?}"
        );
        assert!(usage.memory_bytes > 1024 * 1024, "{usage:?}");
        assert!(usage.memory_total_bytes > 512 * 1024 * 1024, "{usage:?}");
        assert!(usage.memory_bytes < usage.memory_total_bytes, "{usage:?}");
        if let Some(gpu) = &usage.gpu {
            assert!((0.0..=100.0).contains(&gpu.percent), "{usage:?}");
            assert!(gpu.name.as_deref() != Some(""), "{usage:?}");
        }
    }
}

#[test]
fn a_run_is_measured_about_once_a_second_while_it_executes() {
    let python = python_or_skip!();
    let bench = bench(python);
    let member = Member::new(&bench.runner, Answer::Run);
    // Holds 150 MB (written to, so that it is really there) and keeps one core busy.
    let code = "import time\nblob = b'x' * (150 * 1024 * 1024)\nprint('holding', len(blob), flush=True)\nend = time.time() + 3.3\nwhile time.time() < end:\n    pass\nprint('over')\n";
    let mut arrivals: Vec<(Instant, RunEvent)> = Vec::new();
    bench.runner.run(
        RunRequest {
            id: "r".into(),
            code: code.into(),
            title: String::new(),
            lang: None,
            env: None,
        },
        &workspace(),
        &member,
        &mut |e| arrivals.push((Instant::now(), e)),
    );
    let kinds: Vec<_> = arrivals.iter().map(|(_, e)| kind(e)).collect();
    let started = kinds.iter().position(|k| *k == "started").expect("started");
    let samples: Vec<usize> = (0..kinds.len()).filter(|n| kinds[*n] == "stats").collect();
    assert!(samples.len() >= 2 && samples.len() <= 5, "{kinds:?}");
    // All of them while the process runs: after `started`, before `done`, which is last.
    assert!(samples[0] > started, "{kinds:?}");
    assert_eq!(kinds.last(), Some(&"done"));
    assert_eq!(kinds.iter().filter(|k| **k == "done").count(), 1);
    // The first within about a second, the others about a second apart.
    let at = |n: usize| arrivals[n].0;
    let first = at(samples[0]).duration_since(at(started));
    assert!(first < Duration::from_millis(2500), "{first:?}");
    for pair in samples.windows(2) {
        let gap = at(pair[1]).duration_since(at(pair[0]));
        assert!(
            gap > Duration::from_millis(500) && gap < Duration::from_millis(2500),
            "{gap:?}"
        );
    }

    let run = done(arrivals.into_iter().map(|(_, e)| e).collect());
    assert_eq!(run.exit, Some(0));
    assert_plausible(&run.stats);
    let busiest = run.stats.iter().map(|u| u.cpu_percent).fold(0.0, f64::max);
    assert!(busiest > 25.0, "one busy core was measured as {busiest}%");
    let largest = run.stats.iter().map(|u| u.memory_bytes).max().unwrap();
    assert!(
        largest > 150 * 1024 * 1024 && largest < 1024 * 1024 * 1024,
        "150 MB were measured as {largest} bytes"
    );
    // The code said nothing, and showed no bar.
    assert_eq!(said(&run.stats), [(None, None)]);
    // Nothing of it is in the result.
    assert_eq!(run.output, "holding 157286400\nover\n");
}

#[test]
fn what_the_code_says_through_qoop_arrives_with_the_samples() {
    let python = python_or_skip!();
    let bench = bench(python);
    // Each thing is said for a second and a half: long enough to be sampled. The loop says
    // a thousand things at once: the last one is the one that counts.
    let code = r#"import time
import qoop
qoop.step("thermalising")
time.sleep(1.5)
qoop.progress(3, 10)
time.sleep(1.5)
qoop.progress(7, 10, "sweep")
time.sleep(1.5)
for n in range(1000):
    qoop.progress(n, 999)
qoop.step(text="measuring")
time.sleep(1.5)
print(sorted(name for name in dir(qoop) if not name.startswith("_")))
"#;
    let run = bench.run(code);
    assert_eq!(run.exit, Some(0), "{}", run.output);
    assert_eq!(run.output, "['progress', 'step']\n");
    assert_plausible(&run.stats);
    assert_eq!(
        said(&run.stats),
        [
            (Some("thermalising"), None),
            (Some("thermalising"), Some((3.0, 10.0))),
            (Some("sweep"), Some((7.0, 10.0))),
            (Some("measuring"), Some((999.0, 999.0))),
        ]
    );
}

#[test]
fn a_progress_bar_in_the_output_says_how_far_when_qoop_was_not_used() {
    let python = python_or_skip!();
    let bench = bench(python);
    // What tqdm writes: the bar again and again on one line of standard error.
    let bars = r#"import sys, time
print("start")
for n in (15, 45):
    sys.stderr.write("\rsweep:  %d%%|####5     | %d/100 [00:00<00:00, 749.48it/s]" % (n, n))
    sys.stderr.flush()
    time.sleep(1.5)
"#;
    let run = bench.run(bars);
    assert_eq!(run.exit, Some(0), "{}", run.output);
    assert_eq!(
        said(&run.stats),
        [
            (Some("sweep"), Some((15.0, 100.0))),
            (Some("sweep"), Some((45.0, 100.0))),
        ]
    );
    // The output is kept as it was written.
    assert_eq!(
        run.output,
        "start\n\rsweep:  15%|####5     | 15/100 [00:00<00:00, 749.48it/s]\rsweep:  45%|####5     | 45/100 [00:00<00:00, 749.48it/s]"
    );
    assert_eq!(run.streamed.concat(), run.output);

    // What the code says itself goes before what its bar shows.
    let both = format!("import qoop\nqoop.step('by hand')\n{bars}");
    let run = bench.run(&both);
    assert_eq!(run.exit, Some(0), "{}", run.output);
    assert_eq!(said(&run.stats), [(Some("by hand"), None)]);
}

#[test]
fn what_a_child_process_uses_is_counted() {
    let python = python_or_skip!();
    let bench = bench(python);
    // The program itself only waits; its child holds 120 MB and keeps a core busy.
    let code = r#"import subprocess, sys
child = "import time\nblob = b'x' * (120 * 1024 * 1024)\nend = time.time() + 3.3\nwhile time.time() < end:\n    pass\n"
print(subprocess.call([sys.executable, "-c", child]))
"#;
    let run = bench.run(code);
    assert_eq!((run.exit, run.output.as_str()), (Some(0), "0\n"));
    assert!(run.stats.len() >= 2, "{:?}", run.kinds);
    assert_plausible(&run.stats);
    let most = run.stats.iter().map(|u| u.processes).max().unwrap();
    assert!(most >= 2, "{:?}", run.stats);
    let busiest = run.stats.iter().map(|u| u.cpu_percent).fold(0.0, f64::max);
    assert!(
        busiest > 25.0,
        "the child's busy core was measured as {busiest}%"
    );
    let largest = run.stats.iter().map(|u| u.memory_bytes).max().unwrap();
    assert!(
        largest > 120 * 1024 * 1024,
        "the child's 120 MB were measured as {largest} bytes"
    );
}

#[test]
fn nonsense_said_through_qoop_is_ignored_and_never_fails_the_code() {
    let python = python_or_skip!();
    let bench = bench(python);
    let code = r#"import os, shutil, sys, time
import qoop

class Odd:
    def __float__(self):
        raise RuntimeError("no number")
    def __str__(self):
        raise RuntimeError("no text")

for value in (None, True, b"3", [], {}, Odd(), object(), float("nan"), float("inf"), -float("inf"), 10 ** 400, 1j):
    qoop.progress(value, 10)
    qoop.progress(1, value)
    qoop.progress(value, value, value)
    qoop.step(value)
qoop.progress("3", "10")
qoop.progress(1, 0)
qoop.progress(1, -5)
qoop.progress()
qoop.progress(1)
qoop.progress(1, 2, 3, 4)
qoop.progress(1, 2, nonsense=True)
qoop.step()
qoop.step("a", "b")
qoop.step("")
qoop.step("\ud800 half a character")
qoop.step("\x00\x1b[2J\n\n")
qoop.step("x" * 10_000_000)
time.sleep(1.3)
# Something in the file's place, then no directory at all.
said = os.path.join(os.environ["QOOP_RUN_DIR"], "qoop-progress.json")
if os.path.exists(said):
    os.remove(said)
os.mkdir(said)
qoop.progress(1, 2)
time.sleep(0.3)
qoop.progress(2, 2, "still fine")
shutil.rmtree(os.environ["QOOP_RUN_DIR"], ignore_errors=True)
qoop.step("into nothing")
time.sleep(0.3)
qoop.progress(1, 3)
sys.modules["os"] = sys.modules["json"] = sys.modules["time"] = None
qoop.step("without modules")
time.sleep(0.3)
qoop.progress(2, 3)
print("fine")
"#;
    let run = bench.run(code);
    // Nothing was raised, and nothing was printed that the code did not print.
    assert_eq!((run.exit, run.output.as_str()), (Some(0), "fine\n"));
    assert!(!run.stats.is_empty(), "{:?}", run.kinds);
    assert_plausible(&run.stats);
    // Of all that, two things were text: what is left of a line of control characters, and
    // right after it a very long step, shown as far as a step goes.
    let long = "x".repeat(120);
    for usage in &run.stats {
        assert_eq!(usage.progress, None, "{usage:?}");
        assert!(
            matches!(usage.step.as_deref(), None | Some("[2J")) || usage.step == Some(long.clone()),
            "{usage:?}"
        );
    }
    assert!(run.stats.iter().any(|u| u.step == Some(long.clone())));
}

#[test]
fn cancel_is_as_prompt_while_the_run_is_measured() {
    let python = python_or_skip!();
    let bench = bench(python);
    // Busy, with a child, and saying how far it is all the time; ready after the first
    // samples were taken.
    let code = r#"import subprocess, time
import qoop
child = subprocess.Popen(["sleep", "600"])
begun = time.time()
ready = False
n = 0
while True:
    n += 1
    qoop.progress(n % 1000, 1000, "spinning")
    if not ready and time.time() - begun > 2.2:
        ready = True
        print("ready", flush=True)
"#;
    let mut cancelled = None;
    let run = run_and_interrupt(&bench, code, "ready", |runner, _| {
        cancelled = Some(Instant::now());
        runner.cancel("long-run");
    });
    let took = cancelled.unwrap().elapsed();
    assert!(took < Duration::from_secs(3), "the cancel took {took:?}");
    assert!(run.stopped && run.exit.is_none());
    // It was being measured when it was stopped, and nothing came after `done`.
    assert!(!run.stats.is_empty(), "{:?}", run.kinds);
    assert_plausible(&run.stats);
    assert!(
        run.stats
            .iter()
            .all(|u| u.step.as_deref() == Some("spinning"))
    );
    assert!(
        run.stats.iter().any(|u| u.processes >= 2),
        "{:?}",
        run.stats
    );
    assert_eq!(run.kinds.last(), Some(&"done"));
    assert_eq!(run.kinds.iter().filter(|k| **k == "done").count(), 1);
    assert!(bench.runner.is_idle());
}

// ---- figures and environment ---------------------------------------------------------------

#[test]
fn an_open_figure_is_captured_as_a_png() {
    let python = matplotlib_or_skip!();
    let bench = bench(python);
    let code = "import matplotlib.pyplot as plt\nimport json\nfig, ax = plt.subplots(figsize=(4, 3))\nax.plot([0, 1, 2, 3], [0, 1, 4, 9])\nax.set_title('Squares')\nplt.show()\nprint('plotted')\n";
    let run = bench.run(code);
    assert_eq!(run.exit, Some(0), "{}", run.output);
    // `plt.show()` has no screen here; it must not add noise to the output.
    assert_eq!(run.output, "plotted\n");
    assert_eq!(run.figures.len(), 1);
    // 4 × 3 inches at matplotlib's 100 dots per inch.
    assert_eq!(png_size(&run.figures[0]), (400, 300));
    assert!(run.figures[0].len() > 2000 && run.figures[0].len() <= 120_000);
    assert!(
        run.figures[0].ends_with(b"IEND\xaeB`\x82"),
        "the PNG is cut off"
    );
    // The package the code imports is reported with its version, and what it requires;
    // `json` is not a package.
    let packages = run.packages.expect("packages");
    assert!(packages["matplotlib"].starts_with(|c: char| c.is_ascii_digit()));
    assert!(packages.contains_key("numpy") && !packages.contains_key("json"));
}

#[test]
fn figures_are_kept_when_the_code_fails_and_not_when_they_were_closed() {
    let python = matplotlib_or_skip!();
    let bench = bench(python);
    let run = bench.run(
        "import matplotlib.pyplot as plt\nplt.plot([1, 2])\nraise RuntimeError('after the plot')\n",
    );
    assert_eq!(run.exit, Some(1));
    assert!(run.output.contains("RuntimeError: after the plot"));
    assert_eq!(run.figures.len(), 1);
    png_size(&run.figures[0]);

    let run =
        bench.run("import sys\nimport matplotlib.pyplot as plt\nplt.plot([1, 2])\nsys.exit(3)\n");
    assert_eq!(run.exit, Some(3));
    assert_eq!(run.figures.len(), 1);

    // Closed, or saved by the code itself and closed: nothing is open at the end.
    let run = bench.run("import matplotlib.pyplot as plt\nplt.plot([1, 2])\nplt.savefig('mine.png')\nplt.close('all')\nprint('closed')\n");
    assert_eq!((run.exit, run.output.as_str()), (Some(0), "closed\n"));
    assert!(run.figures.is_empty());

    // matplotlib imported, pyplot not: nothing is imported on the code's behalf.
    let run = bench.run("import matplotlib, sys\nprint('matplotlib.pyplot' in sys.modules)\n");
    assert_eq!(run.output, "False\n");
    assert!(run.figures.is_empty());
    assert!(run.packages.unwrap().contains_key("matplotlib"));
}

#[test]
fn only_the_first_three_figures_are_kept() {
    let python = matplotlib_or_skip!();
    let bench = bench(python);
    let code = "import matplotlib.pyplot as plt\nfor n in range(5):\n    plt.figure(figsize=(2 + n, 2))\n    plt.plot([0, n])\nprint('five figures')\n";
    let run = bench.run(code);
    assert_eq!(run.exit, Some(0));
    assert_eq!(run.figures.len(), 3);
    // The first three, in order: 2, 3 and 4 inches wide.
    let widths: Vec<u32> = run.figures.iter().map(|f| png_size(f).0).collect();
    assert_eq!(widths, [200, 300, 400]);
    assert_eq!(
        run.output,
        "five figures\n[qoop] 2 more figures were left out: a Run keeps the first three.\n"
    );

    let run = bench.run("import matplotlib.pyplot as plt\nfor n in range(4):\n    plt.figure()\n");
    assert_eq!(run.figures.len(), 3);
    assert_eq!(
        run.output,
        "[qoop] 1 more figure was left out: a Run keeps the first three.\n"
    );
}

#[test]
fn a_figure_too_large_is_saved_smaller_or_left_out() {
    let python = matplotlib_or_skip!();
    let bench = bench(python);
    // Noise does not compress: at 100 dpi this figure is a PNG of well over a megabyte.
    let noise = "import random\nimport matplotlib.pyplot as plt\nrandom.seed(1)\ndef noise(w, h):\n    return [[random.random() for _ in range(w)] for _ in range(h)]\n";
    let code = format!(
        "{noise}fig = plt.figure(figsize=(10, 8))\nplt.imshow(noise(300, 240), interpolation='nearest', aspect='auto')\nplt.figure(figsize=(3, 2))\nplt.plot([1, 2, 3])\nprint('two figures')\n"
    );
    let run = bench.run(&code);
    assert_eq!(run.exit, Some(0), "{}", run.output);
    assert_eq!(run.output, "two figures\n");
    assert_eq!(run.figures.len(), 2);
    let (width, height) = png_size(&run.figures[0]);
    // Saved with fewer dots per inch than the 1000 × 800 it would have had; same shape.
    assert!((100..1000).contains(&width), "{width}");
    assert!(
        (width as f64 / height as f64 - 1.25).abs() < 0.02,
        "{width}x{height}"
    );
    assert!(run.figures[0].len() <= 120_000);
    assert!(
        run.figures[0].len() > 30_000,
        "shrunk far more than needed: {}",
        run.figures[0].len()
    );
    // The small one after it is untouched.
    assert_eq!(png_size(&run.figures[1]), (300, 200));

    // So large that no resolution worth keeping fits: left out, with a note, and the
    // figure after it still kept.
    let code = format!(
        "{noise}plt.figure(figsize=(40, 40))\nplt.imshow(noise(700, 700), interpolation='nearest', aspect='auto')\nplt.axis('off')\nplt.subplots_adjust(0, 0, 1, 1)\nplt.figure(figsize=(3, 2))\nplt.plot([1, 2, 3])\nprint('huge')\n"
    );
    let run = bench.run(&code);
    assert_eq!(run.exit, Some(0), "{}", run.output);
    assert_eq!(
        run.output,
        "huge\n[qoop] Figure 1 was left out: it is too large to keep, even at a low resolution.\n"
    );
    assert_eq!(run.figures.len(), 1);
    assert_eq!(png_size(&run.figures[0]), (300, 200));
}

#[test]
fn the_packages_the_code_imports_are_reported_with_what_they_require() {
    let python = matplotlib_or_skip!();
    let bench = bench(python);
    // matplotlib brings numpy with it, so both are there to import.
    let code = "import os, sys\nimport json as j\nfrom collections import OrderedDict\nimport numpy as np\nfrom matplotlib import cm\nimport numpy.linalg\ntry:\n    import a_package_that_does_not_exist\nexcept ImportError:\n    pass\nprint(np.__version__)\nimport importlib.metadata as m\nprint(sorted(m.requires('matplotlib') or []))\n";
    let run = bench.run(code);
    assert_eq!(run.exit, Some(0), "{}", run.output);
    let packages = run.packages.expect("packages");
    let numpy = run.output.lines().next().unwrap();
    assert_eq!(packages["numpy"], numpy);
    assert!(packages.contains_key("matplotlib"), "{packages:?}");
    // The distribution a module comes from, by its own name (`dateutil` is python-dateutil),
    // where the Python can tell (3.10 and newer).
    let modern = run
        .python
        .as_deref()
        .is_some_and(|v| v.split('.').nth(1).and_then(|m| m.parse::<u32>().ok()) >= Some(10));
    // What matplotlib requires directly is there (cycler, always) …
    assert!(packages.contains_key("cycler"), "{packages:?}");
    // … and nothing further down: six is what python-dateutil requires, not matplotlib.
    if !run.output.contains("'six") {
        assert!(!packages.contains_key("six"), "{packages:?}");
    }
    // Imported itself, python-dateutil brings what it requires.
    if modern {
        let run = bench.run("import dateutil\n");
        let packages = run.packages.expect("packages");
        assert!(packages.contains_key("python-dateutil"), "{packages:?}");
        assert!(packages.contains_key("six"), "{packages:?}");
    }
    // The standard library is never listed, nor anything not installed.
    for absent in [
        "os",
        "sys",
        "json",
        "collections",
        "a_package_that_does_not_exist",
    ] {
        assert!(!packages.contains_key(absent), "{absent}");
    }
    assert!(packages.len() <= qoop_runner::exec::MAX_PACKAGES);
    assert_eq!(
        run.python.as_deref().map(|v| v.starts_with("3.")),
        Some(true)
    );

    // More than 32: the first 32 the code names. (Made-up modules that say their version.)
    let folder = tempfile::tempdir().unwrap();
    let mut code = String::new();
    for n in 0..40 {
        fs::write(
            folder.path().join(format!("pkg{n:02}.py")),
            format!("__version__ = '1.{n}'\n"),
        )
        .unwrap();
        code.push_str(&format!("import pkg{n:02}\n"));
    }
    fs::write(folder.path().join("unversioned.py"), "X = 1\n").unwrap();
    code.insert_str(0, "import unversioned\n");
    bench
        .runner
        .settings_save(Some(&python.path), folder.path().to_str())
        .unwrap();
    let run = bench.run(&code);
    assert_eq!(run.exit, Some(0), "{}", run.output);
    let packages = run.packages.expect("packages");
    assert_eq!(packages.len(), 32);
    assert_eq!(packages.keys().next().map(String::as_str), Some("pkg00"));
    assert_eq!(packages.keys().last().map(String::as_str), Some("pkg31"));
    assert_eq!(packages["pkg03"], "1.3");

    // A syntax error: no packages, but the Python version is still known.
    let run = bench.run("import numpy\nx = (1,\n");
    assert_eq!(run.exit, Some(1));
    assert_eq!(run.packages, None);
    assert!(run.python.is_some());
}

#[test]
fn a_missing_package_is_named_in_one_line() {
    let python = python_or_skip!();
    let bench = bench(python);
    let run = bench.run("print('start')\nimport a_package_that_does_not_exist.sub\n");
    assert_eq!(run.exit, Some(1));
    assert!(run.output.contains("ModuleNotFoundError"), "{}", run.output);
    assert!(
        run.output
            .ends_with("\n[qoop] This environment has no package a_package_that_does_not_exist.\n"),
        "{}",
        run.output
    );
    // A missing part of a package that is there is not a missing package.
    let run = bench.run("import json.no_such_part\n");
    assert_eq!(run.exit, Some(1));
    assert!(run.output.contains("ModuleNotFoundError"), "{}", run.output);
    assert!(!run.output.contains("has no package"), "{}", run.output);
    // Caught by the code: nothing is said.
    let run =
        bench.run("try:\n    import nothing_here_either\nexcept ImportError:\n    print('fine')\n");
    assert_eq!((run.exit, run.output.as_str()), (Some(0), "fine\n"));
}
