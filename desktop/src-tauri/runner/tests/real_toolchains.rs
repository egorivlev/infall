//! The Runner with environments and other languages, against real programs: a Python
//! environment a Run names (found, asked once, remembered), a command Toolchain made of a
//! shell script, the real programs of the presets that are on this machine (Node, bash,
//! Julia, R), and Q# through a Python that has `qdk`. The "Member" answers the settings and
//! approval windows through the same calls those windows make.
//!
//! Which Python: `QOOP_TEST_PYTHON`, else the first the Runner's own lookup finds. Which
//! Python for Q#: `QOOP_TEST_QSHARP_PYTHON`, else that same Python if it has `qdk` (or a
//! `qsharp` of 1.28 or earlier). Anything missing prints a SKIPPED line and passes.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use qoop_runner::exec::Env;
use qoop_runner::python::{self, EnvVars};
use qoop_runner::toolchains;
use qoop_runner::{
    ApprovalView, Ask, Cancel, Change, Options, Reason, RunEvent, RunRequest, Runner, Ui, Workspace,
};

const ORIGIN: &str = "https://qoop.example.org";

fn login_env() -> &'static EnvVars {
    static ENV: OnceLock<EnvVars> = OnceLock::new();
    ENV.get_or_init(python::login_env)
}

fn test_python() -> Option<&'static str> {
    static FOUND: OnceLock<Option<String>> = OnceLock::new();
    FOUND
        .get_or_init(|| {
            if let Some(path) = std::env::var_os("QOOP_TEST_PYTHON") {
                return Some(path.to_string_lossy().into_owned());
            }
            python::find(login_env()).into_iter().next().map(|i| i.path)
        })
        .as_deref()
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

/// A Python whose `qdk` (or old `qsharp`) imports, and that distribution's version.
fn qsharp_python() -> Option<&'static (String, String, String)> {
    static FOUND: OnceLock<Option<(String, String, String)>> = OnceLock::new();
    FOUND
        .get_or_init(|| {
            let path = std::env::var_os("QOOP_TEST_QSHARP_PYTHON")
                .map(|p| p.to_string_lossy().into_owned())
                .or_else(|| test_python().map(str::to_owned))?;
            let q = python::qsharp_probe(Path::new(&path), login_env()).ok()?;
            eprintln!("Q# tests use {path} ({} {})", q.package, q.version);
            Some((path, q.package, q.version))
        })
        .as_ref()
}

/// What the Member does in the settings window, given what it was opened to ask.
type Configure<'a> = dyn Fn(&Runner, Option<Ask>) + Send + Sync + 'a;

/// The app's windows with a Member in front of them: the approval is answered with "Run";
/// what is done in the settings window is `configure`.
struct Member<'a> {
    runner: &'a Runner,
    configure: Box<Configure<'a>>,
    asked_for: Mutex<Vec<Option<Ask>>>,
    shown: Mutex<Vec<Arc<ApprovalView>>>,
}

impl<'a> Member<'a> {
    fn new(runner: &'a Runner) -> Self {
        Self::configuring(runner, |_, _| {})
    }

    fn configuring(
        runner: &'a Runner,
        configure: impl Fn(&Runner, Option<Ask>) + Send + Sync + 'a,
    ) -> Self {
        Self {
            runner,
            configure: Box::new(configure),
            asked_for: Mutex::default(),
            shown: Mutex::default(),
        }
    }

    fn approvals(&self) -> usize {
        self.shown.lock().unwrap().len()
    }
}

impl Ui for Member<'_> {
    fn configure(&self, _cancel: &Cancel) {
        let ask = self.runner.asking();
        self.asked_for.lock().unwrap().push(ask.clone());
        (self.configure)(self.runner, ask);
    }

    fn show_approval(&self, ticket: u64) -> bool {
        let view = self
            .runner
            .approval_view(ticket)
            .expect("a question is open");
        self.shown.lock().unwrap().push(view);
        self.runner.approval_decide(ticket, true).unwrap();
        true
    }

    fn close_approval(&self, _ticket: u64) {}
}

struct Bench {
    runner: Arc<Runner>,
    _config: tempfile::TempDir,
    temp_root: tempfile::TempDir,
}

fn bench_with_env(env: EnvVars, python: Option<&str>) -> Bench {
    let config = tempfile::tempdir().unwrap();
    let temp_root = tempfile::tempdir().unwrap();
    let mut options = Options::new(config.path());
    options.min_view = Duration::ZERO;
    options.kill_grace = Duration::from_millis(300);
    options.temp_root = temp_root.path().to_owned();
    options.env = Some(env);
    let runner = Arc::new(Runner::new(options));
    if let Some(python) = python {
        runner.settings_save(Some(python), None).unwrap();
    }
    Bench {
        runner,
        _config: config,
        temp_root,
    }
}

fn bench(python: Option<&str>) -> Bench {
    bench_with_env(login_env().clone(), python)
}

#[derive(Debug)]
struct Done {
    lang: String,
    exit: Option<i32>,
    stopped: bool,
    output: String,
    figures: usize,
    env: Env,
}

impl Bench {
    fn events(
        &self,
        member: &Member,
        lang: Option<&str>,
        env: Option<&str>,
        code: &str,
    ) -> Vec<RunEvent> {
        let mut events = Vec::new();
        self.runner.run(
            RunRequest {
                id: "run-1".into(),
                code: code.to_owned(),
                title: "Test Run".into(),
                lang: lang.map(str::to_owned),
                env: env.map(str::to_owned),
            },
            &Workspace {
                key: ORIGIN.into(),
                name: ORIGIN.into(),
            },
            member,
            &mut |e| events.push(e),
        );
        assert!(self.runner.is_idle());
        assert_eq!(
            fs::read_dir(self.temp_root.path()).unwrap().count(),
            0,
            "the Run's temporary directory was not removed"
        );
        events
    }

    fn run(&self, member: &Member, lang: Option<&str>, env: Option<&str>, code: &str) -> Done {
        done(self.events(member, lang, env, code))
    }
}

fn done(events: Vec<RunEvent>) -> Done {
    match events.into_iter().last() {
        Some(RunEvent::Done {
            lang,
            exit,
            stopped,
            output,
            figures,
            env,
            ..
        }) => Done {
            lang,
            exit,
            stopped,
            output,
            figures: figures.len(),
            env,
        },
        other => panic!("the Run did not end with `done`: {other:?}"),
    }
}

fn failure(events: &[RunEvent]) -> (Reason, String) {
    match events {
        [.., RunEvent::Error { reason, message }] => (*reason, message.clone()),
        other => panic!("expected an error at the end: {other:?}"),
    }
}

fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

// ---- Python environments ---------------------------------------------------------------------

/// A real virtual environment of the test Python, made where a conda installation keeps
/// its environments (`<home>/miniconda3/envs/<name>`, with a `conda-meta` folder), so the
/// Runner finds it as the conda environment `<name>`.
fn conda_like_env(python: &str, home: &Path, name: &str) -> PathBuf {
    let prefix = home.join("miniconda3/envs").join(name);
    let made = Command::new(python)
        .args(["-m", "venv", "--without-pip"])
        .arg(&prefix)
        .status()
        .unwrap();
    assert!(made.success(), "could not make a virtual environment");
    fs::create_dir_all(prefix.join("conda-meta")).unwrap();
    fs::create_dir_all(home.join("miniconda3/conda-meta")).unwrap();
    prefix
}

#[test]
fn a_run_naming_an_environment_of_this_device_runs_there() {
    let python = python_or_skip!();
    let home = tempfile::tempdir().unwrap();
    let home_path = home.path().canonicalize().unwrap();
    let prefix = conda_like_env(python, &home_path, "analysis");
    let mut env = login_env().clone();
    env.retain(|(k, _)| k != "HOME" && k != "CONDA_EXE" && k != "PYENV_ROOT");
    env.push(("HOME".into(), home_path.clone().into()));
    let bench = bench_with_env(env, Some(python));

    // The page learns the name exists here, and nothing about where.
    let status = bench.runner.status();
    assert!(
        status.environments.contains(&"analysis".to_owned()),
        "{status:?}"
    );
    assert!(status.languages.contains_key("python"));

    let member = Member::new(&bench.runner);
    let code = "import sys\nprint(sys.prefix)\n";
    let run = bench.run(&member, None, Some("analysis"), code);
    assert_eq!(run.exit, Some(0), "{}", run.output);
    assert_eq!(
        Path::new(run.output.trim()).canonicalize().unwrap(),
        prefix.canonicalize().unwrap()
    );
    assert_eq!(run.lang, "python");
    assert!(run.env.python.as_deref().unwrap().starts_with("3."));
    // Nothing was asked but the approval, and it named the environment and its interpreter.
    assert!(member.asked_for.lock().unwrap().is_empty());
    {
        let shown = member.shown.lock().unwrap();
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0].environment.as_deref(), Some("analysis"));
        assert!(
            Path::new(&shown[0].program).starts_with(&prefix),
            "{}",
            shown[0].program
        );
    }

    // The same code in the default environment is another interpreter: asked again.
    let member = Member::new(&bench.runner);
    let run = bench.run(&member, None, None, code);
    assert_eq!(run.exit, Some(0));
    assert_eq!(member.approvals(), 1);
    assert_eq!(member.shown.lock().unwrap()[0].environment, None);
    // And each again runs without asking.
    for env in [None, Some("analysis")] {
        let member = Member::new(&bench.runner);
        assert_eq!(bench.run(&member, None, env, code).exit, Some(0));
        assert_eq!(member.approvals(), 0);
    }
}

#[test]
fn an_environment_this_device_lacks_is_asked_once_and_remembered() {
    let python = python_or_skip!();
    let bench = bench(Some(python));
    let code = "print('in the chosen one')\n";

    // Closed without an answer: nothing runs.
    let member = Member::new(&bench.runner);
    let events = bench.events(&member, None, Some("thesis-2027"), code);
    assert_eq!(events.len(), 1);
    let (reason, message) = failure(&events);
    assert_eq!(reason, Reason::NoEnvironment);
    assert_eq!(
        message,
        "No environment on this computer is chosen for “thesis-2027”."
    );
    assert_eq!(
        *member.asked_for.lock().unwrap(),
        [Some(Ask::Env("thesis-2027".into()))]
    );
    assert_eq!(member.approvals(), 0);

    // The Member chooses an interpreter for that name: the Run goes on.
    let chosen = python.to_owned();
    let member = Member::configuring(&bench.runner, move |runner, ask| {
        if let Some(Ask::Env(name)) = ask {
            runner
                .settings_change(Change::Map {
                    name,
                    path: Some(chosen.clone()),
                })
                .unwrap();
        }
    });
    let run = bench.run(&member, None, Some("thesis-2027"), code);
    assert_eq!(run.output, "in the chosen one\n");
    assert_eq!(member.asked_for.lock().unwrap().len(), 1);
    // Remembered: the next Run naming it is not asked about it.
    let member = Member::new(&bench.runner);
    assert_eq!(
        bench.run(&member, None, Some("thesis-2027"), code).exit,
        Some(0)
    );
    assert!(member.asked_for.lock().unwrap().is_empty());
    assert!(
        bench
            .runner
            .status()
            .environments
            .contains(&"thesis-2027".to_owned())
    );
    // While the window is closed, it asks nothing.
    assert_eq!(bench.runner.asking(), None);

    // A name that cannot be one is refused before anything is shown.
    let member = Member::new(&bench.runner);
    for bad in ["a\nb", &"x".repeat(61)] {
        let events = bench.events(&member, None, Some(bad), code);
        assert_eq!(failure(&events).0, Reason::Failed);
    }
    // Empty is the default environment.
    assert_eq!(bench.run(&member, None, Some(""), code).exit, Some(0));
    assert!(member.asked_for.lock().unwrap().is_empty());
}

// ---- a command Toolchain ---------------------------------------------------------------------

/// A pretend language: a shell script that reports how it was started.
fn fake_language(dir: &Path) -> PathBuf {
    script(
        dir,
        "fake-lang",
        r#"if [ "$1" = --version ]; then echo 'fake-lang 2.5 (test)'; exit 0; fi
echo "args: $#"
for a in "$@"; do echo "arg: $a"; done
echo "cwd: $(pwd)"
echo "run dir: $QOOP_RUN_DIR"
echo "code: $(cat "$2")"
echo "mpl: ${MPLBACKEND:-unset} py: ${PYTHONUNBUFFERED:-unset}"
echo "telemetry: $QDK_PYTHON_TELEMETRY $HF_HUB_DISABLE_TELEMETRY"
echo "err line" >&2
printf '\211PNG\r\n\032\nfigure bytes' > "$QOOP_RUN_DIR/qoop-figure-1.png"
printf 'not a png' > "$QOOP_RUN_DIR/qoop-figure-2.png"
case "$(cat "$2")" in *forever*) echo "pid $$"; sleep 600;; esac
exit 3"#,
    )
}

#[test]
fn a_command_toolchain_runs_its_program_with_the_file_and_nothing_else() {
    let python = test_python();
    let tools = tempfile::tempdir().unwrap();
    let program = fake_language(tools.path());
    let bench = bench(python);
    bench
        .runner
        .settings_change(Change::SetLanguage {
            id: "fake".into(),
            name: "Fake".into(),
            program: program.to_str().unwrap().into(),
            args: vec!["--run".into(), "{file}".into()],
            ext: "fk".into(),
        })
        .unwrap();
    let status = bench.runner.status();
    let fake = &status.languages["fake"];
    assert_eq!(
        (fake.name.as_str(), fake.version.as_deref()),
        ("Fake", Some("fake-lang 2.5 (test)"))
    );

    let member = Member::new(&bench.runner);
    let code = "say 'hello' ; $(rm -rf /) `x` *\n";
    let run = bench.run(
        &member,
        Some("fake"),
        Some("ignored-for-other-languages"),
        code,
    );
    assert_eq!(run.lang, "fake");
    assert_eq!(run.exit, Some(3));
    let lines: Vec<&str> = run.output.lines().collect();
    assert_eq!(lines[0], "args: 2");
    assert_eq!(lines[1], "arg: --run");
    let file = lines[2].strip_prefix("arg: ").unwrap();
    assert!(file.ends_with("/main.fk"), "{file}");
    let run_dir = lines[4].strip_prefix("run dir: ").unwrap();
    assert_eq!(Path::new(file).parent().unwrap(), Path::new(run_dir));
    // No folder chosen: it runs in its own temporary directory.
    assert_eq!(lines[3], format!("cwd: {run_dir}"));
    // The code reached the program as a file, untouched by any shell.
    assert_eq!(lines[5], format!("code: {}", code.trim_end()));
    // The Python-only variables are not set; the usage-report switches are.
    assert_eq!(lines[6], "mpl: unset py: unset");
    assert_eq!(lines[7], "telemetry: none 1");
    assert_eq!(lines[8], "err line");
    // A real PNG left in the Run's directory is a figure; the rest is not.
    assert_eq!(run.figures, 1);
    assert_eq!(run.env.runtime.as_deref(), Some("fake-lang 2.5 (test)"));
    assert_eq!(
        (run.env.python.as_ref(), run.env.packages.as_ref()),
        (None, None)
    );
    assert!(run.env.os.is_some() && run.env.arch.is_some());
    // The window named the language and the command.
    let shown = member.shown.lock().unwrap();
    assert_eq!(shown[0].lang, "fake");
    assert_eq!(shown[0].language, "Fake");
    assert_eq!(shown[0].program, program.to_str().unwrap());
    assert_eq!(
        shown[0].args.as_deref(),
        Some(&["--run".to_owned(), "{file}".to_owned()][..])
    );
    assert_eq!(shown[0].environment, None);
    drop(shown);

    // Stopping it stops its whole group.
    let runner = bench.runner.clone();
    let started = Arc::new(AtomicUsize::new(0));
    let seen = started.clone();
    let worker = thread::spawn(move || {
        let member = Member::new(&runner);
        let mut events = Vec::new();
        runner.run(
            RunRequest {
                id: "long".into(),
                code: "forever".into(),
                title: String::new(),
                lang: Some("fake".into()),
                env: None,
            },
            &Workspace {
                key: ORIGIN.into(),
                name: ORIGIN.into(),
            },
            &member,
            &mut |e| {
                if matches!(&e, RunEvent::Output { text } if text.contains("pid ")) {
                    seen.store(1, Ordering::SeqCst);
                }
                events.push(e);
            },
        );
        events
    });
    let deadline = Instant::now() + Duration::from_secs(20);
    while started.load(Ordering::SeqCst) == 0 {
        assert!(Instant::now() < deadline, "the script never started");
        thread::sleep(Duration::from_millis(20));
    }
    let began = Instant::now();
    bench.runner.cancel("long");
    let run = done(worker.join().unwrap());
    assert!(began.elapsed() < Duration::from_secs(5));
    assert!(run.stopped && run.exit.is_none());
    assert_eq!(run.figures, 0);
    let pid: i32 = run
        .output
        .lines()
        .find_map(|l| l.strip_prefix("pid "))
        .expect("the script said its pid")
        .parse()
        .unwrap();
    thread::sleep(Duration::from_millis(200));
    // SAFETY: signal 0 only asks whether the group exists.
    assert!(unsafe { libc::kill(-pid, 0) } != 0, "the group survived");
}

#[test]
fn a_language_that_is_not_set_up_is_asked_for_and_never_run_as_python() {
    let python = test_python();
    let tools = tempfile::tempdir().unwrap();
    let program = fake_language(tools.path());
    let bench = bench(python);
    let proof = tools.path().join("it-ran");
    let code = format!("open({:?}, 'w').close()\n", proof.to_str().unwrap());

    // Not set up: the settings window is opened at that language; closed, nothing runs.
    for (lang, sentence) in [
        (
            "julia",
            "Julia is not set up in Runner settings on this computer.",
        ),
        (
            "haskell",
            "haskell is not set up in Runner settings on this computer.",
        ),
        (
            "qsharp",
            "Q# is not set up in Runner settings on this computer.",
        ),
    ] {
        let member = Member::new(&bench.runner);
        let events = bench.events(&member, Some(lang), None, &code);
        assert_eq!(events.len(), 1, "{lang}");
        assert_eq!(failure(&events), (Reason::NoToolchain, sentence.to_owned()));
        assert_eq!(
            *member.asked_for.lock().unwrap(),
            [Some(Ask::Lang(lang.into()))]
        );
        assert_eq!(member.approvals(), 0);
    }
    // Not a language id: refused before any window.
    let member = Member::new(&bench.runner);
    for bad in ["Julia", "", "a b", "x".repeat(25).as_str()] {
        let events = bench.events(&member, Some(bad), None, &code);
        assert_eq!(failure(&events).0, Reason::Failed, "{bad:?}");
    }
    assert!(member.asked_for.lock().unwrap().is_empty());
    assert!(!proof.exists(), "something ran the code as Python");

    // Set up in the window when asked: the Run goes on with it.
    let path = program.to_str().unwrap().to_owned();
    let member = Member::configuring(&bench.runner, move |runner, ask| {
        if let Some(Ask::Lang(id)) = ask {
            runner
                .settings_change(Change::SetLanguage {
                    id,
                    name: "Haskell".into(),
                    program: path.clone(),
                    args: vec!["-x".into(), "{file}".into()],
                    ext: "hs".into(),
                })
                .unwrap();
        }
    });
    let run = bench.run(&member, Some("haskell"), None, "main = print 1\n");
    assert_eq!((run.lang.as_str(), run.exit), ("haskell", Some(3)));
    assert!(run.output.contains("main.hs"), "{}", run.output);

    // Switched off: as if it were not set up.
    bench
        .runner
        .settings_change(Change::EnableLanguage {
            id: "haskell".into(),
            on: false,
        })
        .unwrap();
    assert!(!bench.runner.status().languages.contains_key("haskell"));
    let member = Member::new(&bench.runner);
    let events = bench.events(&member, Some("haskell"), None, "main = print 1\n");
    assert_eq!(failure(&events).0, Reason::NoToolchain);

    // Python and Q# cannot be redefined; a .bat-like or relative program is refused.
    for id in ["python", "qsharp"] {
        let refused = bench.runner.settings_change(Change::SetLanguage {
            id: id.into(),
            name: "X".into(),
            program: program.to_str().unwrap().into(),
            args: vec!["{file}".into()],
            ext: "x".into(),
        });
        assert!(refused.unwrap_err().contains("built in"));
    }
    let refused = bench.runner.settings_change(Change::SetLanguage {
        id: "rel".into(),
        name: "X".into(),
        program: "fake-lang".into(),
        args: vec!["{file}".into()],
        ext: "x".into(),
    });
    assert!(refused.unwrap_err().contains("full path"));
}

// ---- the presets' real programs ------------------------------------------------------------

/// Sets up a preset with the first program found for it on this machine; `None` (and a
/// SKIPPED line) when there is none.
fn set_up_preset(bench: &Bench, id: &str) -> Option<String> {
    let preset = toolchains::preset(id).unwrap();
    let Some(found) = toolchains::find_programs(preset, login_env())
        .into_iter()
        .next()
    else {
        eprintln!("SKIPPED: no program for {} on this machine", preset.name);
        return None;
    };
    bench
        .runner
        .settings_change(Change::SetLanguage {
            id: id.into(),
            name: preset.name.into(),
            program: found.path.clone(),
            args: vec!["{file}".into()],
            ext: preset.ext.into(),
        })
        .unwrap();
    eprintln!(
        "{} through {} ({:?})",
        preset.name, found.path, found.version
    );
    Some(found.path)
}

#[test]
fn the_presets_programs_on_this_machine_run_their_code() {
    let bench = bench(test_python());
    let cases: [(&str, &str, &str, i32); 4] = [
        (
            "javascript",
            "const x = [1, 2, 3].map(n => n * n);\nconsole.log(x.join(','));\nconsole.error('to stderr');\nprocess.exit(5);\n",
            "1,4,9\nto stderr\n",
            5,
        ),
        (
            "shell",
            "echo \"hello from $0\" | sed 's/main.sh/the file/' | grep -o 'hello from .*the file'\nexit 4\n",
            "",
            4,
        ),
        ("julia", "println(sum([1, 2, 3]))\n", "6\n", 0),
        ("r", "cat(sum(1:3), \"\\n\")\n", "6 \n", 0),
    ];
    let mut ran = Vec::new();
    for (id, code, expected, exit) in cases {
        if set_up_preset(&bench, id).is_none() {
            continue;
        }
        let member = Member::new(&bench.runner);
        let run = bench.run(&member, Some(id), None, code);
        assert_eq!(run.lang, id);
        assert_eq!(run.exit, Some(exit), "{id}: {}", run.output);
        if id == "shell" {
            assert!(run.output.starts_with("hello from "), "{}", run.output);
            assert!(
                run.output.trim_end().ends_with("the file"),
                "{}",
                run.output
            );
        } else {
            assert_eq!(run.output, expected, "{id}");
        }
        assert!(run.env.runtime.is_some(), "{id}: no version");
        assert!(!run.stopped);
        assert!(bench.runner.status().languages.contains_key(id));
        ran.push(id);
    }
    eprintln!("ran: {ran:?}");
}

// ---- Q# --------------------------------------------------------------------------------------

macro_rules! qsharp_or_skip {
    () => {
        match qsharp_python() {
            Some(found) => found,
            None => {
                eprintln!("SKIPPED: no Python with qdk (or qsharp 1.28) on this machine");
                return;
            }
        }
    };
}

/// The samples of docs/specs/qsharp-check.md §6, and what they printed there. A `?` line
/// is a measurement (random), checked by its shape.
const SAMPLES: &[(&str, &str, &[&str], i32)] = &[
    (
        "01_statements",
        "Message(\"Hello from Q#\");\nuse qs = Qubit[3];\nApplyToEach(H, qs);\nMResetEachZ(qs)\n",
        &["Hello from Q#", "?[_, _, _]"],
        0,
    ),
    (
        "02_main",
        "// Run Main() to get a Bell pair.\noperation Main() : (Result, Result) {\n    use (a, b) = (Qubit(), Qubit());\n    H(a);\n    CNOT(a, b);\n    Message(\"Bell pair prepared\");\n    (MResetZ(a), MResetZ(b))\n}\n",
        &["Bell pair prepared", "?(_, _)"],
        0,
    ),
    (
        "03_namespace",
        "namespace Demo {\n    function Square(x : Int) : Int { x * x }\n    operation Main() : Int[] {\n        Message($\"square of 3 is {Square(3)}\");\n        [Square(1), Square(2), Square(3)]\n    }\n}\n",
        &["square of 3 is 9", "[1, 4, 9]"],
        0,
    ),
    (
        "04_entrypoint",
        "namespace Demo {\n    @EntryPoint()\n    operation Teleport() : Bool {\n        Message(\"teleporting\");\n        true\n    }\n    operation Main(n : Int) : Int { n }\n}\n",
        &["teleporting", "true"],
        0,
    ),
    (
        "05_main_called",
        "operation Main() : Int {\n    Message(\"Main ran\");\n    5\n}\nMain()\n",
        &["Main ran", "5"],
        0,
    ),
    (
        "06_no_entry",
        "operation Helper() : Unit { Message(\"never called\"); }\n",
        &[],
        0,
    ),
    (
        "07_syntax_error",
        "operation Main() : Int {\n    let x = ;\n    x\n}\n",
        &["~Qsc.Parse.Rule", "", "  x syntax error"],
        1,
    ),
    (
        "08_runtime_failure",
        "operation Main() : Unit {\n    Message(\"about to fail\");\n    fail \"the angle must be positive\";\n}\n",
        &[
            "about to fail",
            "Error: program failed: the angle must be positive",
            "Call stack:",
            "    at Main in line_0:3:5",
            "~Qsc.Eval.UserFail",
        ],
        1,
    ),
    (
        "09_main_with_args",
        "operation Main(shots : Int) : Int { shots }\n",
        &[
            "~Qsc.EntryPoint.Args",
            "",
            "  x entry point cannot have parameters",
        ],
        1,
    ),
    (
        "10_unicode",
        "Message(\"Привет, кубит ⟩ — ok\");\n\"строка\"\n",
        &["Привет, кубит ⟩ — ok", "строка"],
        0,
    ),
    (
        "11_main_unit",
        "operation Main() : Unit {\n    use q = Qubit();\n    H(q);\n    Microsoft.Quantum.Diagnostics.DumpMachine();\n    Reset(q);\n}\n",
        &["STATE:", "|0⟩: 0.7071+0.0000𝑖", "|1⟩: 0.7071+0.0000𝑖"],
        0,
    ),
    (
        "12_values",
        "(1, true, One, \"s\", 2.5, PauliX, 1..3, [Zero, One])\n",
        &["(1, true, One, s, 2.5, PauliX, 1..3, [Zero, One])"],
        0,
    ),
    (
        "13_long",
        "operation Main() : Int {\n    mutable total = 0;\n    for step in 1..5 {\n        for i in 0..2000000 { set total += i % 3; }\n        Message($\"step {step} of 5\");\n    }\n    total\n}\n",
        &[
            "step 1 of 5",
            "step 2 of 5",
            "step 3 of 5",
            "step 4 of 5",
            "step 5 of 5",
            "10000005",
        ],
        0,
    ),
];

/// A measured line: `[_, _]` or `(_, _)` with each `_` One or Zero.
fn measurement_like(shape: &str, line: &str) -> bool {
    let words: Vec<&str> = line
        .trim_matches(|c| c == '[' || c == ']' || c == '(' || c == ')')
        .split(", ")
        .collect();
    let open = shape.chars().next() == line.chars().next();
    open && words.len() == shape.matches('_').count()
        && words.iter().all(|w| *w == "One" || *w == "Zero")
}

fn qsharp_bench(python: &str) -> Bench {
    let bench = bench(Some(python));
    bench
        .runner
        .settings_change(Change::Qsharp { on: true })
        .unwrap();
    bench
}

#[test]
fn the_q_sharp_samples_run_as_the_check_says() {
    let (python, package, version) = qsharp_or_skip!();
    let bench = qsharp_bench(python);
    let status = bench.runner.status();
    assert_eq!(
        status.languages["qsharp"].version.as_deref(),
        Some(format!("{package} {version}").as_str())
    );
    for (name, code, expected, exit) in SAMPLES {
        let member = Member::new(&bench.runner);
        let run = bench.run(&member, Some("qsharp"), None, code);
        assert_eq!(run.lang, "qsharp");
        assert_eq!(run.exit, Some(*exit), "{name}: {}", run.output);
        let lines: Vec<&str> = run.output.lines().collect();
        assert!(lines.len() >= expected.len(), "{name}: {}", run.output);
        if expected.is_empty() {
            assert_eq!(run.output, "", "{name}");
        }
        for (got, want) in lines.iter().zip(expected.iter()) {
            if let Some(shape) = want.strip_prefix('?') {
                assert!(measurement_like(shape, got), "{name}: {got:?}");
            } else if let Some(code) = want.strip_prefix('~') {
                // `Qdk.Qsc.…` since qdk; `Qsc.…` in qsharp 1.28 and an early qdk.
                assert!(
                    *got == code || *got == format!("Qdk.{code}"),
                    "{name}: {got:?}"
                );
            } else {
                assert_eq!(got, want, "{name}");
            }
        }
        if *exit == 0 {
            assert_eq!(lines.len(), expected.len(), "{name}: {}", run.output);
        }
        // Nothing of Python's shows, ever.
        assert!(!run.output.contains("Traceback"), "{name}: {}", run.output);
        assert!(
            !run.output.contains("qsharp_runner"),
            "{name}: {}",
            run.output
        );
        // The environment is a Python Run's, with the one distribution that ran it.
        assert!(run.env.python.as_deref().unwrap().starts_with("3."));
        assert_eq!(
            run.env
                .packages
                .as_ref()
                .map(|p| p.iter().collect::<Vec<_>>()),
            Some(vec![(package, version)]),
            "{name}"
        );
        assert_eq!(run.env.runtime, None);
        assert_eq!(run.figures, 0);
        let shown = member.shown.lock().unwrap();
        assert_eq!(
            (shown[0].lang.as_str(), shown[0].language.as_str()),
            ("qsharp", "Q#")
        );
        assert_eq!(shown[0].program, *python);
    }
}

#[test]
fn a_q_sharp_run_that_never_ends_is_stopped_at_once() {
    let (python, _, _) = qsharp_or_skip!();
    let bench = qsharp_bench(python);
    let runner = bench.runner.clone();
    let started = Arc::new(AtomicUsize::new(0));
    let seen = started.clone();
    let worker = thread::spawn(move || {
        let member = Member::new(&runner);
        let mut events = Vec::new();
        runner.run(
            RunRequest {
                id: "endless".into(),
                code: "operation Main() : Unit {\n    mutable i = 0;\n    Message(\"looping forever\");\n    while true { set i += 1; }\n}\n".into(),
                title: String::new(),
                lang: Some("qsharp".into()),
                env: None,
            },
            &Workspace {
                key: ORIGIN.into(),
                name: ORIGIN.into(),
            },
            &member,
            &mut |e| {
                if matches!(&e, RunEvent::Output { text } if text.contains("looping forever")) {
                    seen.store(1, Ordering::SeqCst);
                }
                events.push(e);
            },
        );
        events
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    while started.load(Ordering::SeqCst) == 0 {
        assert!(Instant::now() < deadline, "the Q# loop never started");
        thread::sleep(Duration::from_millis(20));
    }
    let began = Instant::now();
    bench.runner.cancel("endless");
    let run = done(worker.join().unwrap());
    assert!(run.stopped && run.exit.is_none());
    assert!(
        began.elapsed() < Duration::from_secs(3),
        "{:?}",
        began.elapsed()
    );
    assert!(run.output.starts_with("looping forever"));
}

#[test]
fn q_sharp_cannot_be_turned_on_for_a_python_without_it() {
    // A stand-in Python that answers like 3.12 but has neither distribution.
    let tools = tempfile::tempdir().unwrap();
    let fake = script(
        tools.path(),
        "python3",
        "case \"$*\" in *--version*) echo 'Python 3.12.0';; *) echo 'QOOP 3.12';; esac",
    );
    let bench = bench(Some(fake.to_str().unwrap()));
    let refused = bench
        .runner
        .settings_change(Change::Qsharp { on: true })
        .unwrap_err();
    assert!(refused.contains("pip install qdk"), "{refused}");
    assert!(refused.contains("3.10"), "{refused}");
    assert!(!bench.runner.status().languages.contains_key("qsharp"));
    // An older one is told so.
    let old = script(
        tools.path(),
        "python-old",
        "case \"$*\" in *--version*) echo 'Python 3.9.6';; *) echo 'QOOP 3.9';; esac",
    );
    bench
        .runner
        .settings_save(Some(old.to_str().unwrap()), None)
        .unwrap();
    let refused = bench
        .runner
        .settings_change(Change::Qsharp { on: true })
        .unwrap_err();
    assert!(
        refused.starts_with("Q# needs Python 3.10 or newer"),
        "{refused}"
    );
    // With no Python chosen at all.
    bench.runner.settings_save(None, None).unwrap();
    assert!(
        bench
            .runner
            .settings_change(Change::Qsharp { on: true })
            .unwrap_err()
            .contains("Choose a Python first")
    );
}

#[test]
fn a_q_sharp_run_without_q_sharp_in_its_python_says_what_to_install() {
    let python = python_or_skip!();
    let probe = python::qsharp_probe(Path::new(python), login_env());
    if probe.is_ok() {
        // Make an environment without it, and point Q# Runs there by name.
        let home = tempfile::tempdir().unwrap();
        let prefix = conda_like_env(python, home.path(), "bare");
        let bench = qsharp_bench(python);
        bench
            .runner
            .settings_change(Change::Map {
                name: "bare".into(),
                path: Some(prefix.join("bin/python").to_str().unwrap().into()),
            })
            .unwrap();
        let member = Member::new(&bench.runner);
        let run = bench.run(&member, Some("qsharp"), Some("bare"), "Message(\"hi\");\n");
        if run.exit == Some(0) {
            eprintln!("SKIPPED: the bare environment still sees qdk (user site?)");
            return;
        }
        assert_eq!(run.exit, Some(1));
        assert_eq!(
            run.output,
            "Q# is not installed for this Python. Install it with: pip install qdk (it needs Python 3.10 or newer).\n"
        );
        assert_eq!(run.env.packages, None);
        assert_eq!(
            member.shown.lock().unwrap()[0].environment.as_deref(),
            Some("bare")
        );
    } else {
        eprintln!("SKIPPED: the test Python has no qdk, so Q# cannot be turned on for it");
    }
}
