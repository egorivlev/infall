//! The Runner with environments and other languages, against real programs: a Python
//! environment a Run names (found, asked once, remembered), a command Toolchain made of a
//! shell script, the real programs of the presets that are on this machine (Node, bash,
//! Julia, R), and Q# through a Python that has `qdk`. The "Member" answers the settings and
//! approval windows through the same calls those windows make.
//!
//! Which Python: `INFALL_TEST_PYTHON`, else the first the Runner's own lookup finds. Which
//! Python for Q#: `INFALL_TEST_QSHARP_PYTHON`, else that same Python if it has `qdk` (or a
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

use infall_runner::exec::Env;
use infall_runner::python::{self, EnvVars};
use infall_runner::toolchains;
use infall_runner::{
    ApprovalView, Ask, Cancel, Change, Options, Reason, RunEvent, RunRequest, Runner, Ui, Workspace,
};

const ORIGIN: &str = "https://infall.example.org";

fn login_env() -> &'static EnvVars {
    static ENV: OnceLock<EnvVars> = OnceLock::new();
    ENV.get_or_init(python::login_env)
}

fn test_python() -> Option<&'static str> {
    static FOUND: OnceLock<Option<String>> = OnceLock::new();
    FOUND
        .get_or_init(|| {
            if let Some(path) = std::env::var_os("INFALL_TEST_PYTHON") {
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
            let path = std::env::var_os("INFALL_TEST_QSHARP_PYTHON")
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
echo "run dir: $INFALL_RUN_DIR"
echo "code: $(cat "$2")"
echo "mpl: ${MPLBACKEND:-unset} py: ${PYTHONUNBUFFERED:-unset}"
echo "telemetry: $QDK_PYTHON_TELEMETRY $HF_HUB_DISABLE_TELEMETRY"
echo "err line" >&2
printf '\211PNG\r\n\032\nfigure bytes' > "$INFALL_RUN_DIR/infall-figure-1.png"
printf 'not a png' > "$INFALL_RUN_DIR/infall-figure-2.png"
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
fn stopping_a_run_also_ends_what_it_started_in_another_process_group() {
    let tools = tempfile::tempdir().unwrap();
    // A shell with job control puts each background job in a group of its own.
    let program = script(
        tools.path(),
        "job-lang",
        r#"if [ "$1" = --version ]; then echo 'job-lang 1'; exit 0; fi
set -m
sleep 600 &
echo "escaped $!"
(sleep 600 & echo "escaped $!"; wait) &
sleep 0.2
echo "running"
sleep 600"#,
    );
    let bench = bench(test_python());
    bench
        .runner
        .settings_change(Change::SetLanguage {
            id: "jobs".into(),
            name: "Jobs".into(),
            program: program.to_str().unwrap().into(),
            args: vec!["{file}".into()],
            ext: "jobs".into(),
        })
        .unwrap();
    let (run, took) = stop_when(&bench, "jobs", "x\n", "running", Duration::from_secs(20));
    assert!(run.stopped && run.exit.is_none(), "{run:?}");
    assert!(took < Duration::from_secs(5), "{took:?}");
    let escaped = pids_after(&run.output, "escaped ");
    assert_eq!(escaped.len(), 2, "{}", run.output);
    thread::sleep(Duration::from_millis(200));
    let left: Vec<_> = escaped.iter().filter(|p| exists(**p)).collect();
    for p in &left {
        // SAFETY: only the processes this Run said it started.
        unsafe { libc::kill(**p, libc::SIGKILL) };
    }
    assert!(left.is_empty(), "left behind: {left:?}");
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

// ---- Julia and R with real researcher code ---------------------------------------------------
//
// Each case runs for both, each skipped (with a line) where its program is missing. How long
// each Run took is printed: Julia starts in about half a second, more on its first run after
// an install (it precompiles), and the Runner has no time limit on a Run.

const JULIA_AND_R: [&str; 2] = ["julia", "r"];

/// A bench with `id` set up from this machine's first program for it; `None` when there is
/// none (a SKIPPED line was printed).
fn bench_for(env: EnvVars, id: &str) -> Option<Bench> {
    let bench = bench_with_env(env, test_python());
    set_up_preset(&bench, id)?;
    Some(bench)
}

/// Runs `code` in `id` to its end, printing how long it took.
fn timed_run(bench: &Bench, id: &str, case: &str, code: &str) -> Done {
    let member = Member::new(&bench.runner);
    let began = Instant::now();
    let run = bench.run(&member, Some(id), None, code);
    eprintln!("{id} {case}: {:?}", began.elapsed());
    assert_eq!(run.lang, id);
    assert!(run.env.runtime.is_some(), "{id}: no version");
    run
}

#[test]
fn julia_and_r_keep_standard_output_and_error_in_the_order_written() {
    // No flush in either: the Runner gives both streams one pipe, and neither language holds
    // back what it writes to a pipe at a line's end, so lines come out as they were written.
    let julia = r#"
for epoch in 1:25
    loss = round(1 / epoch, digits = 4)
    println("epoch $epoch loss $loss")
    epoch % 5 == 0 && println(stderr, "checkpoint $epoch")
end
println(stderr, "warning: learning rate not tuned")
println("done")
"#;
    let r = r#"
for (epoch in 1:25) {
  loss <- round(1 / epoch, 4)
  cat("epoch ", epoch, " loss ", loss, "\n", sep = "")
  if (epoch %% 5 == 0) message("checkpoint ", epoch)
}
message("warning: learning rate not tuned")
cat("done\n")
"#;
    let mut expected = String::new();
    for epoch in 1..=25u32 {
        let loss = 1.0 / f64::from(epoch);
        let loss = (loss * 10_000.0).round() / 10_000.0;
        expected.push_str(&format!("epoch {epoch} loss {loss}\n"));
        if epoch % 5 == 0 {
            expected.push_str(&format!("checkpoint {epoch}\n"));
        }
    }
    expected.push_str("warning: learning rate not tuned\ndone\n");
    for (id, code) in JULIA_AND_R.into_iter().zip([julia, r]) {
        let Some(bench) = bench_for(login_env().clone(), id) else {
            continue;
        };
        let run = timed_run(&bench, id, "order", code);
        assert_eq!(run.exit, Some(0), "{id}: {}", run.output);
        // (Julia prints 1.0 as `1.0`, R as `1`; the rest are alike.)
        let output = run.output.replace("epoch 1 loss 1.0\n", "epoch 1 loss 1\n");
        assert_eq!(output, expected, "{id}");
        assert!(!run.stopped);
    }
}

#[test]
fn an_uncaught_error_in_julia_or_r_fails_the_run_with_the_languages_own_message() {
    let julia = r#"
function concentration(absorbance, path_cm)
    absorbance < 0 && throw(DomainError(absorbance, "absorbance must not be negative"))
    absorbance / (6220 * path_cm)
end
println("sample A: ", concentration(0.5, 1.0))
println("sample B: ", concentration(-0.1, 1.0))
println("never printed")
"#;
    let r = r#"
concentration <- function(absorbance, path_cm) {
  if (absorbance < 0) stop("absorbance must not be negative")
  absorbance / (6220 * path_cm)
}
cat("sample A:", concentration(0.5, 1), "\n")
cat("sample B:", concentration(-0.1, 1), "\n")
cat("never printed\n")
"#;
    for (id, code) in JULIA_AND_R.into_iter().zip([julia, r]) {
        let Some(bench) = bench_for(login_env().clone(), id) else {
            continue;
        };
        let run = timed_run(&bench, id, "error", code);
        assert_eq!(run.exit, Some(1), "{id}: {}", run.output);
        assert!(!run.stopped, "{id}");
        assert!(
            run.output.starts_with("sample A: 8.03"),
            "{id}: {}",
            run.output
        );
        assert!(!run.output.contains("never printed"), "{id}");
        assert!(!run.output.contains("[infall]"), "{id}: {}", run.output);
        if id == "julia" {
            // `ERROR: LoadError: DomainError with -0.1:` then the message and a stacktrace.
            assert!(
                run.output
                    .contains("ERROR: LoadError: DomainError with -0.1:"),
                "{}",
                run.output
            );
            assert!(run.output.contains("absorbance must not be negative"));
            assert!(run.output.contains("Stacktrace:"), "{}", run.output);
            assert!(run.output.contains("main.jl:3"), "{}", run.output);
        } else {
            assert!(
                run.output.contains(
                    "Error in concentration(-0.1, 1) : absorbance must not be negative\n"
                ),
                "{}",
                run.output
            );
            assert!(run.output.ends_with("Execution halted\n"), "{}", run.output);
        }
    }
}

#[test]
fn an_exit_code_julia_or_r_chooses_is_the_runs() {
    let julia = "n_failed = 3\nprintln(\"$n_failed checks failed\")\nexit(n_failed)\n";
    let r = "n_failed <- 3\ncat(n_failed, \"checks failed\\n\")\nquit(save = \"no\", status = n_failed)\n";
    for (id, code) in JULIA_AND_R.into_iter().zip([julia, r]) {
        let Some(bench) = bench_for(login_env().clone(), id) else {
            continue;
        };
        let run = timed_run(&bench, id, "exit", code);
        assert_eq!(run.exit, Some(3), "{id}: {}", run.output);
        assert_eq!(run.output, "3 checks failed\n", "{id}");
        assert!(!run.stopped);
    }
}

#[test]
fn julia_and_r_compute_with_their_standard_libraries() {
    let julia = r#"
using LinearAlgebra, Statistics
A = [4.0 1.0; 2.0 3.0]
println("det = ", round(det(A), digits = 8))
println("eigenvalues = ", round.(eigvals(A), digits = 8))
println("solution = ", round.(A \ [1.0, 2.0], digits = 8))
println("norm = ", round(norm([3.0, 4.0]), digits = 8))
data = [2.0, 4.0, 4.0, 4.0, 5.0, 5.0, 7.0, 9.0]
println("mean = ", mean(data), " median = ", median(data), " sd = ", round(std(data), digits = 6))
println("cor = ", round(cor([1.0, 2.0, 3.0, 4.0], [2.0, 4.1, 5.9, 8.2]), digits = 6))
"#;
    let r = r#"
d <- data.frame(dose = c(1, 2, 3, 4, 5), response = c(2.1, 3.9, 6.2, 7.8, 10.1))
fit <- lm(response ~ dose, data = d)
cat(sprintf("intercept = %.4f slope = %.4f\n", coef(fit)[[1]], coef(fit)[[2]]))
cat(sprintf("r.squared = %.6f\n", summary(fit)$r.squared))
cat(sprintf("mean = %.2f sd = %.6f median = %.1f\n", mean(d$response), sd(d$response), median(d$response)))
cat(sprintf("t.test p = %.6f\n", t.test(d$response, mu = 5)$p.value))
"#;
    let expected = [
        "det = 10.0\neigenvalues = [2.0, 5.0]\nsolution = [0.1, 0.6]\nnorm = 5.0\n\
         mean = 5.0 median = 4.5 sd = 2.13809\ncor = 0.998992\n",
        "intercept = 0.0500 slope = 1.9900\nr.squared = 0.997305\n\
         mean = 6.02 sd = 3.150714 median = 6.2\nt.test p = 0.509200\n",
    ];
    for ((id, code), expected) in JULIA_AND_R.into_iter().zip([julia, r]).zip(expected) {
        let Some(bench) = bench_for(login_env().clone(), id) else {
            continue;
        };
        let run = timed_run(&bench, id, "numerics", code);
        assert_eq!(run.exit, Some(0), "{id}: {}", run.output);
        assert_eq!(run.output, expected, "{id}");
    }
}

/// A 64×48 colour gradient written as a PNG by hand: Julia's standard library has no plotting
/// and no deflate, so the image data goes in "stored" (uncompressed) zlib blocks, with
/// CRC-32 and Adler-32 computed here.
const JULIA_PNG: &str = r#"
const CRC_TABLE = [begin
    c = UInt32(n)
    for _ in 1:8
        c = isodd(c) ? 0xedb88320 ⊻ (c >> 1) : c >> 1
    end
    c
end for n in 0:255]
crc32(data) = ~foldl((c, b) -> CRC_TABLE[((c ⊻ b) & 0xff) + 1] ⊻ (c >> 8), data; init = 0xffffffff)
function adler32(data)
    a, b = UInt32(1), UInt32(0)
    for x in data
        a = (a + x) % 65521
        b = (b + a) % 65521
    end
    (b << 16) | a
end
be32(x) = collect(reinterpret(UInt8, [hton(UInt32(x))]))
chunk(kind, data) = vcat(be32(length(data)), Vector{UInt8}(kind), data,
                         be32(crc32(vcat(Vector{UInt8}(kind), data))))

w, h = 64, 48
raw = UInt8[]
for y in 0:h-1
    push!(raw, 0x00)
    for x in 0:w-1
        append!(raw, UInt8[round(UInt8, 255x / (w - 1)), round(UInt8, 255y / (h - 1)), 0x80])
    end
end
z = UInt8[0x78, 0x01]
starts = 1:65535:length(raw)
for start in starts
    block = raw[start:min(start + 65534, end)]
    n = length(block)
    append!(z, UInt8[start == last(starts) ? 1 : 0, n & 0xff, n >> 8, ~n & 0xff, (~n >> 8) & 0xff])
    append!(z, block)
end
append!(z, be32(adler32(raw)))
png = vcat(UInt8[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
           chunk("IHDR", vcat(be32(w), be32(h), UInt8[8, 2, 0, 0, 0])),
           chunk("IDAT", z), chunk("IEND", UInt8[]))
write(joinpath(ENV["INFALL_RUN_DIR"], "infall-figure-1.png"), png)
println("figure: ", length(png), " bytes")
"#;

/// Base graphics into a PNG, no package: Cairo where R has it (headless anywhere), else
/// R's own default bitmap device (Quartz on a Mac).
const R_PNG: &str = r#"
x <- seq(0, 2 * pi, length.out = 200)
f <- file.path(Sys.getenv("INFALL_RUN_DIR"), "infall-figure-1.png")
png(f, width = 640, height = 480,
    type = if (capabilities("cairo")) "cairo" else getOption("bitmapType"))
plot(x, sin(x), type = "l", col = "steelblue", lwd = 2, main = "sin(x)", xlab = "x", ylab = "y")
abline(h = 0, lty = 2)
invisible(dev.off())
cat("figure:", file.exists(f), "\n")
"#;

#[test]
fn a_png_julia_or_r_writes_into_the_runs_folder_is_its_figure() {
    for (id, code) in JULIA_AND_R.into_iter().zip([JULIA_PNG, R_PNG]) {
        let Some(bench) = bench_for(login_env().clone(), id) else {
            continue;
        };
        let run = timed_run(&bench, id, "figure", code);
        assert_eq!(run.exit, Some(0), "{id}: {}", run.output);
        if id == "julia" {
            // Signature 8, IHDR 25, IDAT 12 + (2 + 5 + 48 × 193 + 4), IEND 12.
            assert_eq!(run.output, "figure: 9332 bytes\n");
        } else {
            assert_eq!(run.output, "figure: TRUE \n");
        }
        assert_eq!(run.figures, 1, "{id}");
    }
}

#[test]
fn unicode_julia_or_r_prints_survives_with_or_without_a_locale() {
    let julia = "s = \"αβγ 🧪\"\nprintln(\"μ = 1.5 ± 0.2, Δt = 3 ms, σ² ≈ 0.04 🚀\")\n@show s\nprintln(length(s), \" characters\")\n";
    let r = "s <- \"αβγ 🧪\"\ncat(\"μ = 1.5 ± 0.2, Δt = 3 ms, σ² ≈ 0.04 🚀\\n\")\nprint(s)\ncat(nchar(s), \"characters\\n\")\n";
    let expected = [
        "μ = 1.5 ± 0.2, Δt = 3 ms, σ² ≈ 0.04 🚀\ns = \"αβγ 🧪\"\n5 characters\n",
        "μ = 1.5 ± 0.2, Δt = 3 ms, σ² ≈ 0.04 🚀\n[1] \"αβγ 🧪\"\n5 characters\n",
    ];
    // The app started from the Finder: often no locale at all in the login shell's
    // environment. R in the "C" locale would print `"\316\261\316\262…"` and count 11.
    let mut bare = login_env().clone();
    bare.retain(|(k, _)| k != "LANG" && !k.to_string_lossy().starts_with("LC_"));
    for ((id, code), expected) in JULIA_AND_R.into_iter().zip([julia, r]).zip(expected) {
        for (which, env) in [("locale", login_env().clone()), ("no locale", bare.clone())] {
            let Some(bench) = bench_for(env, id) else {
                break;
            };
            let run = timed_run(&bench, id, &format!("unicode, {which}"), code);
            assert_eq!(run.exit, Some(0), "{id}, {which}: {}", run.output);
            assert_eq!(run.output, expected, "{id}, {which}");
        }
    }
}

/// Starts `code` in `id` on a thread, waits (up to `start_within`) for a line starting with
/// `marker`, stops the Run, and returns how it ended and how long the stop took.
fn stop_when(
    bench: &Bench,
    id: &str,
    code: &str,
    marker: &'static str,
    start_within: Duration,
) -> (Done, Duration) {
    let runner = bench.runner.clone();
    let started = Arc::new(AtomicUsize::new(0));
    let seen = started.clone();
    let (lang, code) = (id.to_owned(), code.to_owned());
    let launched = Instant::now();
    let worker = thread::spawn(move || {
        let member = Member::new(&runner);
        let mut events = Vec::new();
        let mut text = String::new();
        runner.run(
            RunRequest {
                id: "long".into(),
                code,
                title: String::new(),
                lang: Some(lang),
                env: None,
            },
            &Workspace {
                key: ORIGIN.into(),
                name: ORIGIN.into(),
            },
            &member,
            &mut |e| {
                if let RunEvent::Output { text: more } = &e {
                    text.push_str(more);
                    if text.lines().any(|l| l.starts_with(marker)) {
                        seen.store(1, Ordering::SeqCst);
                    }
                }
                events.push(e);
            },
        );
        events
    });
    let deadline = Instant::now() + start_within;
    while started.load(Ordering::SeqCst) == 0 {
        assert!(Instant::now() < deadline, "{id}: the loop never started");
        thread::sleep(Duration::from_millis(20));
    }
    eprintln!("{id} stop: running after {:?}", launched.elapsed());
    let began = Instant::now();
    bench.runner.cancel("long");
    let run = done(worker.join().unwrap());
    let took = began.elapsed();
    eprintln!("{id} stop: stopped in {took:?}");
    (run, took)
}

fn pids_after(output: &str, prefix: &str) -> Vec<i32> {
    output
        .lines()
        .filter_map(|l| l.strip_prefix(prefix))
        .map(|p| p.trim().parse().unwrap())
        .collect()
}

/// Whether the process (or, negative, the group) `pid` still exists.
fn exists(pid: i32) -> bool {
    // SAFETY: signal 0 only asks whether it exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

#[test]
fn a_julia_or_r_loop_is_stopped_at_once_and_leaves_nothing_behind() {
    // Julia: the loop runs in tasks on Julia's threads (one unless the Member's environment
    // says more). R starts no threads or processes of its own for this.
    let julia = r#"
using Base.Threads
println("pid ", getpid())
println("threads ", nthreads())
tasks = [Threads.@spawn begin
    s = 0.0
    while true
        s += sin(s) + 1e-9
    end
end for _ in 1:2]
foreach(wait, tasks)
"#;
    let r = r#"
cat("pid ", Sys.getpid(), "\n", sep = "")
total <- 0
repeat {
  total <- total + sqrt(runif(1))
}
"#;
    for (id, code) in JULIA_AND_R.into_iter().zip([julia, r]) {
        let Some(bench) = bench_for(login_env().clone(), id) else {
            continue;
        };
        let (run, took) = stop_when(&bench, id, code, "pid ", Duration::from_secs(60));
        assert!(run.stopped && run.exit.is_none(), "{id}: {run:?}");
        assert!(took < Duration::from_secs(5), "{id}: {took:?}");
        let pid = pids_after(&run.output, "pid ")[0];
        thread::sleep(Duration::from_millis(200));
        assert!(!exists(-pid), "{id}: the group survived");
        assert!(!exists(pid), "{id}: the process survived");
    }
}

/// Julia's `Distributed` starts its workers as processes of their own, each in a process
/// group of its own (`detach`), so stopping the Run's group does not reach them. Julia ends
/// them itself when it exits on the Runner's polite request, but only some 300 to 500 ms
/// after it, about when the Runner stops waiting: before the Runner looked for what left
/// the group, a stopped Run could leave both workers running for good. `detach(…)` with
/// `run(…; wait = false)` is the same, and Julia never ends that one: it shows the Runner
/// does it.
#[test]
fn a_julia_run_with_distributed_workers_is_stopped_with_its_workers() {
    let Some(bench) = bench_for(login_env().clone(), "julia") else {
        return;
    };
    let code = r#"
using Distributed
addprocs(2)
@everywhere simulate(seed) = (s = 0.0; for i in 1:10^6; s += sin(seed * i); end; s)
println("partial sums: ", length(pmap(simulate, 1:4)))
for w in workers()
    println("worker ", remotecall_fetch(getpid, w))
end
helper = run(detach(`sleep 600`); wait = false)
println("worker ", getpid(helper))
println("looping")
while true
    pmap(simulate, 1:4)
end
"#;
    let (run, took) = stop_when(&bench, "julia", code, "looping", Duration::from_secs(120));
    assert!(run.stopped && run.exit.is_none(), "{run:?}");
    assert!(took < Duration::from_secs(5), "{took:?}");
    let workers = pids_after(&run.output, "worker ");
    assert_eq!(workers.len(), 3, "{}", run.output);
    let deadline = Instant::now() + Duration::from_secs(3);
    while workers.iter().any(|w| exists(*w)) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(50));
    }
    let left: Vec<_> = workers.iter().filter(|w| exists(**w)).collect();
    for w in &left {
        // SAFETY: only the workers this Run said it started.
        unsafe { libc::kill(**w, libc::SIGKILL) };
    }
    assert!(left.is_empty(), "workers left behind: {left:?}");
}

#[test]
fn julia_and_r_get_the_runs_file_and_run_in_the_runs_folder_or_the_chosen_one() {
    let julia = r#"
println("file: ", abspath(PROGRAM_FILE))
println("cwd: ", pwd())
println("run dir: ", ENV["INFALL_RUN_DIR"])
println("args: ", length(ARGS))
open("results.csv", "w") do io
    println(io, "sample,value")
    println(io, "A,1.5")
end
println("wrote: ", isfile(joinpath(pwd(), "results.csv")))
"#;
    let r = r#"
file <- sub("^--file=", "", grep("^--file=", commandArgs(trailingOnly = FALSE), value = TRUE))
cat("file: ", normalizePath(file), "\n", sep = "")
cat("cwd: ", getwd(), "\n", sep = "")
cat("run dir: ", Sys.getenv("INFALL_RUN_DIR"), "\n", sep = "")
cat("args: ", length(commandArgs(trailingOnly = TRUE)), "\n", sep = "")
write.csv(data.frame(sample = "A", value = 1.5), "results.csv", row.names = FALSE)
cat("wrote: ", file.exists(file.path(getwd(), "results.csv")), "\n", sep = "")
"#;
    // The Run's folder is gone when it is over, so it cannot be canonicalised then; on a Mac
    // `/var` is `/private/var`, which `pwd()` and `getwd()` say.
    let real = |p: &str| PathBuf::from(p.strip_prefix("/private").unwrap_or(p));
    for ((id, code), ext) in JULIA_AND_R.into_iter().zip([julia, r]).zip(["jl", "R"]) {
        let Some(bench) = bench_for(login_env().clone(), id) else {
            continue;
        };
        let field = |run: &Done, name: &str| -> String {
            run.output
                .lines()
                .find_map(|l| l.strip_prefix(name))
                .unwrap_or_else(|| panic!("{id}: no {name:?} in {}", run.output))
                .to_owned()
        };
        let wrote = if id == "julia" { "true" } else { "TRUE" };

        // No folder chosen: the Run's own temporary folder, which holds its file.
        let run = timed_run(&bench, id, "folder", code);
        assert_eq!(run.exit, Some(0), "{id}: {}", run.output);
        let file = field(&run, "file: ");
        assert!(file.ends_with(&format!("/main.{ext}")), "{id}: {file}");
        let run_dir = field(&run, "run dir: ");
        assert_eq!(real(&file).parent().unwrap(), real(&run_dir), "{id}");
        assert_eq!(real(&field(&run, "cwd: ")), real(&run_dir), "{id}");
        // `{file}` is the one argument: the code sees no others.
        assert_eq!(field(&run, "args: "), "0", "{id}");
        assert_eq!(field(&run, "wrote: "), wrote, "{id}");

        // A folder chosen: the Run works there; its file is still in its own folder.
        let folder = tempfile::tempdir().unwrap();
        bench
            .runner
            .settings_save(test_python(), folder.path().to_str())
            .unwrap();
        let run = timed_run(&bench, id, "chosen folder", code);
        assert_eq!(run.exit, Some(0), "{id}: {}", run.output);
        let chosen = folder.path().canonicalize().unwrap();
        assert_eq!(
            real(&field(&run, "cwd: ")),
            real(chosen.to_str().unwrap()),
            "{id}"
        );
        let file = field(&run, "file: ");
        assert!(file.ends_with(&format!("/main.{ext}")), "{id}: {file}");
        assert_eq!(
            real(&file).parent().unwrap(),
            real(&field(&run, "run dir: ")),
            "{id}"
        );
        assert_eq!(field(&run, "wrote: "), wrote, "{id}");
        let csv = fs::read_to_string(folder.path().join("results.csv")).unwrap();
        // (R's `write.csv` quotes text: `"A",1.5`.)
        assert!(csv.replace('"', "").contains("A,1.5"), "{id}: {csv}");
    }
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
        "case \"$*\" in *--version*) echo 'Python 3.12.0';; *) echo 'INFALL 3.12';; esac",
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
        "case \"$*\" in *--version*) echo 'Python 3.9.6';; *) echo 'INFALL 3.9';; esac",
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
