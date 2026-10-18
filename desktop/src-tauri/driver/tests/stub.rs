//! The driver against a stub `claude` (tests/stub-claude.sh): what it is started with, how
//! its output is mapped, and that it is stopped when it should be. No real `claude` runs.
#![cfg(unix)]

use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use qoop_claude_driver::{AiEvent, Cancel, Driver, Outcome, RunRequest, Secret, Status};

const TOKEN: &str = "qoop_pat_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";

struct Stub {
    driver: Driver,
    /// Where the stub records how it was started.
    record: PathBuf,
    _dir: tempfile::TempDir,
}

fn stub(mode: &str) -> Stub {
    let bin = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/stub-claude.sh");
    let mode_bits = fs::metadata(&bin).unwrap().permissions().mode();
    assert!(
        mode_bits & 0o100 != 0,
        "tests/stub-claude.sh must be executable"
    );
    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("record");
    fs::create_dir(&record).unwrap();
    let mut driver = Driver::new(bin);
    driver.work_root = dir.path().join("work");
    driver.silence_timeout = Duration::from_secs(20);
    driver.exit_grace = Duration::from_secs(5);
    driver.kill_grace = Duration::from_secs(5);
    driver.env = vec![
        (OsString::from("QOOP_STUB_DIR"), record.clone().into()),
        (OsString::from("QOOP_STUB_MODE"), mode.into()),
    ];
    Stub {
        driver,
        record,
        _dir: dir,
    }
}

fn request() -> RunRequest {
    RunRequest {
        prompt: "What is on the board?\nSecond line — with ünïcode and 'quotes' and $(echo no)."
            .into(),
        system: "You are inside Qoop.\nBranch: main; `rm -rf` is just text.".into(),
        resume: None,
        tools_url: "http://localhost:8787/mcp".into(),
        tools_token: Secret::new(TOKEN),
    }
}

fn run(stub: &Stub, request: &RunRequest) -> (Outcome, Vec<AiEvent>) {
    let mut events = Vec::new();
    let outcome = stub
        .driver
        .run(request, &Cancel::new(), &mut |e| events.push(e));
    (outcome, events)
}

fn recorded(stub: &Stub, name: &str) -> String {
    fs::read_to_string(stub.record.join(name)).unwrap_or_else(|e| panic!("no record {name}: {e}"))
}

fn argv(stub: &Stub) -> Vec<String> {
    let raw = fs::read(stub.record.join("argv")).unwrap();
    let mut args: Vec<String> = raw
        .split(|b| *b == 0)
        .map(|a| String::from_utf8(a.to_vec()).unwrap())
        .collect();
    assert_eq!(args.pop().as_deref(), Some(""), "argv record ends with NUL");
    args
}

fn delta(text: &str) -> AiEvent {
    AiEvent::Delta { text: text.into() }
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

fn wait_for<T>(what: &str, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        thread::sleep(Duration::from_millis(10));
    }
}

fn pid_file(stub: &Stub, name: &str) -> i32 {
    let path = stub.record.join(name);
    wait_for(name, || fs::read_to_string(&path).ok()?.trim().parse().ok())
}

fn assert_gone(pid: i32, what: &str) {
    // An orphan is reaped by init a moment after it dies.
    let deadline = Instant::now() + Duration::from_secs(5);
    while alive(pid) {
        assert!(
            Instant::now() < deadline,
            "{what} (pid {pid}) is still running"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

/// Runs in a thread; returns the cancel handle, the events as they arrive, and the outcome.
fn run_in_background(
    stub: &Stub,
) -> (Cancel, mpsc::Receiver<AiEvent>, thread::JoinHandle<Outcome>) {
    let cancel = Cancel::new();
    let (tx, rx) = mpsc::channel();
    let driver = stub.driver.clone();
    let handle = {
        let cancel = cancel.clone();
        thread::spawn(move || {
            driver.run(&request(), &cancel, &mut |e| {
                let _ = tx.send(e);
            })
        })
    };
    (cancel, rx, handle)
}

#[test]
fn a_normal_answer_with_a_tool_call() {
    let stub = stub("answer");
    let (outcome, events) = run(&stub, &request());
    assert_eq!(outcome, Outcome::Done);
    assert_eq!(
        events,
        vec![
            delta("Looking at "),
            delta("the board."),
            AiEvent::Tool {
                name: "list_cards".into()
            },
            delta("\n\nIt is empty."),
            AiEvent::Done {
                model: Some("claude-stub-1".into()),
                session: Some("sess-42".into())
            },
        ]
    );
}

#[test]
fn the_token_is_in_the_owner_only_file_and_nowhere_on_the_command_line() {
    let stub = stub("answer");
    let (outcome, _) = run(&stub, &request());
    assert_eq!(outcome, Outcome::Done);

    let args = argv(&stub);
    assert!(
        !args
            .iter()
            .any(|a| a.contains(TOKEN) || a.contains("qoop_pat_")),
        "the token is in the arguments"
    );

    // The file the stub was given held the endpoint and the token…
    let config: serde_json::Value = serde_json::from_str(&recorded(&stub, "mcp-config")).unwrap();
    assert_eq!(
        config,
        serde_json::json!({ "mcpServers": { "qoop": {
            "type": "http",
            "url": "http://localhost:8787/mcp",
            "headers": { "Authorization": format!("Bearer {TOKEN}") }
        }}})
    );
    // …was readable and writable by the owner only…
    assert_eq!(recorded(&stub, "mcp-mode").trim(), "-rw-------");
    // …is the file named after --mcp-config…
    let path = PathBuf::from(recorded(&stub, "mcp-path"));
    let at = args.iter().position(|a| a == "--mcp-config").unwrap();
    assert_eq!(Path::new(&args[at + 1]), path);
    assert!(path.is_absolute());
    // …in a folder nobody else can enter, and not in the working directory…
    let folder = path.parent().unwrap();
    assert_eq!(
        fs::metadata(folder).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_ne!(folder, Path::new(recorded(&stub, "cwd").trim()));
    // …and is gone now.
    assert!(!path.exists(), "the MCP config file was not deleted");
    let left: Vec<_> = fs::read_dir(folder)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(left, vec![OsString::from("cwd")]);
}

#[test]
fn started_with_no_built_in_tools_only_the_qoop_tools_and_no_user_settings() {
    let stub = stub("answer");
    run(&stub, &request());
    let args = argv(&stub);
    let value_of = |flag: &str| -> &str {
        let at = args
            .iter()
            .position(|a| a == flag)
            .unwrap_or_else(|| panic!("{flag} missing"));
        &args[at + 1]
    };
    let has = |flag: &str| args.iter().any(|a| a == flag);

    assert!(has("--print"));
    assert_eq!(value_of("--output-format"), "stream-json");
    assert!(has("--include-partial-messages"));
    assert_eq!(value_of("--input-format"), "text");
    // Every built-in tool off.
    assert_eq!(value_of("--tools"), "");
    // Exactly the eight Qoop tools allowed.
    let mut allowed: Vec<&str> = value_of("--allowedTools").split(',').collect();
    allowed.sort_unstable();
    assert_eq!(
        allowed,
        vec![
            "mcp__qoop__get_card",
            "mcp__qoop__list_branches",
            "mcp__qoop__list_cards",
            "mcp__qoop__list_connections",
            "mcp__qoop__list_sources",
            "mcp__qoop__list_suggestions",
            "mcp__qoop__suggest_connection",
            "mcp__qoop__suggest_source",
        ]
    );
    // Nothing may be approved by a prompt, and nothing bypasses permissions.
    assert_eq!(value_of("--permission-prompts"), "none");
    assert_eq!(value_of("--permission-mode"), "dontAsk");
    assert!(
        !args
            .iter()
            .any(|a| a.contains("skip-permissions") || a == "bypassPermissions")
    );
    // Only our MCP server; no settings files; no skills.
    assert!(has("--strict-mcp-config"));
    assert_eq!(value_of("--setting-sources"), "");
    assert!(has("--disable-slash-commands"));
    // Sessions must be kept, or `resume` could not work.
    assert!(!has("--no-session-persistence"));
    // Memory files are switched off through the environment.
    let env = recorded(&stub, "env");
    for line in [
        "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1",
        "CLAUDE_CODE_DISABLE_CLAUDE_MDS=1",
    ] {
        assert!(env.lines().any(|l| l == line), "{line} is not set");
    }
}

#[test]
fn the_prompt_goes_to_standard_input_and_the_system_text_is_one_argument() {
    let stub = stub("answer");
    let request = request();
    run(&stub, &request);
    assert_eq!(recorded(&stub, "stdin"), request.prompt);
    let args = argv(&stub);
    assert!(!args.iter().any(|a| a.contains("What is on the board?")));
    assert_eq!(
        args.iter()
            .filter(|a| a.starts_with("--append-system-prompt"))
            .collect::<Vec<_>>(),
        vec![&format!("--append-system-prompt={}", request.system)]
    );
    assert!(!args.iter().any(|a| a.starts_with("--resume")));
}

#[test]
fn resume_is_passed_when_given() {
    let stub = stub("answer");
    let mut request = request();
    request.resume = Some("0b9f6c1e-1111-4222-8333-444455556666".into());
    run(&stub, &request);
    assert_eq!(
        argv(&stub).last().map(String::as_str),
        Some("--resume=0b9f6c1e-1111-4222-8333-444455556666")
    );
}

#[test]
fn runs_in_an_empty_temporary_directory_that_is_emptied_again_afterwards() {
    let stub = stub("litter");
    let (outcome, _) = run(&stub, &request());
    assert_eq!(outcome, Outcome::Done);
    let cwd = PathBuf::from(recorded(&stub, "cwd").trim());
    assert_eq!(
        recorded(&stub, "cwd-listing"),
        "",
        "the working directory was not empty"
    );
    assert_eq!(
        cwd,
        stub.driver.work_root.canonicalize().unwrap().join("cwd")
    );
    assert_eq!(
        fs::metadata(&cwd).unwrap().permissions().mode() & 0o777,
        0o700
    );
    // What the run left behind is gone.
    assert_eq!(fs::read_dir(&cwd).unwrap().count(), 0);

    // The next run starts in the same place (Claude Code finds a session to resume by its
    // directory), and it is empty again.
    let (outcome, _) = run(&stub, &request());
    assert_eq!(outcome, Outcome::Done);
    assert_eq!(PathBuf::from(recorded(&stub, "cwd").trim()), cwd);
    assert_eq!(recorded(&stub, "cwd-listing"), "");
}

#[test]
fn a_work_folder_that_is_a_symlink_is_refused() {
    let mut stub = stub("answer");
    let elsewhere = tempfile::tempdir().unwrap();
    let link = elsewhere.path().join("link");
    std::os::unix::fs::symlink(elsewhere.path(), &link).unwrap();
    stub.driver.work_root = link;
    let (outcome, events) = run(&stub, &request());
    assert_eq!(outcome, Outcome::Failed);
    assert_eq!(
        events,
        vec![AiEvent::Error {
            message: "Infall could not prepare a temporary folder for Claude Code.".into()
        }]
    );
    assert!(!stub.record.join("argv").exists(), "the stub was started");
}

#[test]
fn garbage_lines_are_ignored() {
    let stub = stub("garbage");
    let (outcome, events) = run(&stub, &request());
    assert_eq!(outcome, Outcome::Done);
    assert_eq!(
        events,
        vec![
            delta("Looking at "),
            delta("the board."),
            AiEvent::Done {
                model: Some("claude-stub-1".into()),
                session: Some("sess-42".into())
            },
        ]
    );
}

#[test]
fn an_error_result_becomes_an_error_event() {
    let stub = stub("error");
    let (outcome, events) = run(&stub, &request());
    assert_eq!(outcome, Outcome::Failed);
    assert_eq!(
        events,
        vec![AiEvent::Error {
            message: "Claude Code reported an error: Invalid API key · Please run /login".into()
        }]
    );
}

#[test]
fn an_error_that_repeats_the_token_is_scrubbed() {
    let stub = stub("leak");
    let (outcome, events) = run(&stub, &request());
    assert_eq!(outcome, Outcome::Failed);
    assert_eq!(
        events,
        vec![AiEvent::Error {
            message: "Claude Code reported an error: MCP server refused Bearer [token]".into()
        }]
    );
}

#[test]
fn exiting_without_a_result_is_an_error() {
    let stub = stub("crash");
    let (outcome, events) = run(&stub, &request());
    assert_eq!(outcome, Outcome::Failed);
    assert_eq!(
        events,
        vec![
            delta("Looking at "),
            AiEvent::Error {
                message: "Claude Code stopped before finishing the answer (exit code 2).".into()
            }
        ]
    );
}

#[test]
fn a_program_that_is_not_there_is_an_error() {
    let mut stub = stub("answer");
    stub.driver.bin = PathBuf::from("/nonexistent/claude");
    let (outcome, events) = run(&stub, &request());
    assert_eq!(outcome, Outcome::Failed);
    assert_eq!(
        events,
        vec![AiEvent::Error {
            message: "Claude Code could not be started on this machine.".into()
        }]
    );
    // Nothing is left behind even then.
    let left: Vec<_> = fs::read_dir(&stub.driver.work_root)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(left, vec![OsString::from("cwd")]);
}

#[test]
fn cancel_stops_the_process_and_its_children() {
    let stub = stub("hang");
    let (cancel, events, handle) = run_in_background(&stub);
    let pid = pid_file(&stub, "pid");
    let child = pid_file(&stub, "child-pid");
    assert!(alive(pid) && alive(child));
    assert_eq!(
        events.recv_timeout(Duration::from_secs(10)).unwrap(),
        delta("Looking at ")
    );
    let mcp_path = PathBuf::from(recorded(&stub, "mcp-path"));
    assert!(
        mcp_path.exists(),
        "the config file is there while the run lasts"
    );

    let started = Instant::now();
    cancel.cancel();
    assert_eq!(handle.join().unwrap(), Outcome::Cancelled);
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "cancel was slow"
    );
    assert!(!alive(pid), "claude is still running");
    assert_gone(child, "claude's child");
    // A cancelled run delivers nothing more, and its files are gone.
    assert!(events.try_recv().is_err());
    assert!(!mcp_path.exists());
}

#[test]
fn cancel_kills_a_process_that_ignores_the_polite_request() {
    let mut stub = stub("stubborn");
    stub.driver.kill_grace = Duration::from_millis(200);
    let (cancel, _events, handle) = run_in_background(&stub);
    let pid = pid_file(&stub, "pid");
    let child = pid_file(&stub, "child-pid");
    cancel.cancel();
    assert_eq!(handle.join().unwrap(), Outcome::Cancelled);
    assert!(!alive(pid));
    assert_gone(child, "claude's child");
}

#[test]
fn cancelling_before_the_start_runs_nothing() {
    let stub = stub("answer");
    let cancel = Cancel::new();
    cancel.cancel();
    let mut events = Vec::new();
    let outcome = stub
        .driver
        .run(&request(), &cancel, &mut |e| events.push(e));
    assert_eq!(outcome, Outcome::Cancelled);
    assert!(events.is_empty());
    assert!(!stub.record.join("argv").exists());
}

#[test]
fn silence_ends_the_run_with_an_error_and_kills_the_process() {
    let mut stub = stub("hang");
    stub.driver.silence_timeout = Duration::from_millis(1500);
    let started = Instant::now();
    let (outcome, events) = run(&stub, &request());
    assert_eq!(outcome, Outcome::Failed);
    assert_eq!(
        events,
        vec![
            delta("Looking at "),
            AiEvent::Error {
                message: "Claude Code gave no output for 1 seconds, so the run was stopped.".into()
            }
        ]
    );
    let took = started.elapsed();
    assert!(
        took >= Duration::from_millis(1500),
        "stopped early: {took:?}"
    );
    assert!(took < Duration::from_secs(8), "stopped late: {took:?}");
    assert!(!alive(pid_file(&stub, "pid")));
    assert_gone(pid_file(&stub, "child-pid"), "claude's child");
    assert!(!PathBuf::from(recorded(&stub, "mcp-path")).exists());
}

#[test]
fn the_default_silence_timeout_is_120_seconds() {
    assert_eq!(
        Driver::new("claude").silence_timeout,
        Duration::from_secs(120)
    );
    assert_eq!(
        qoop_claude_driver::SILENCE_TIMEOUT,
        Duration::from_secs(120)
    );
}

#[test]
fn output_resets_the_silence_timer() {
    // Six lines 150 ms apart: longer in total than the timeout, never silent that long.
    let mut stub = stub("slow");
    stub.driver.silence_timeout = Duration::from_millis(700);
    let started = Instant::now();
    let (outcome, events) = run(&stub, &request());
    assert_eq!(outcome, Outcome::Done);
    assert!(started.elapsed() >= Duration::from_millis(750));
    assert!(matches!(events.last(), Some(AiEvent::Done { .. })));
}

#[test]
fn a_process_that_lingers_after_its_result_is_removed() {
    let mut stub = stub("linger");
    stub.driver.exit_grace = Duration::from_millis(200);
    let started = Instant::now();
    let (outcome, events) = run(&stub, &request());
    assert_eq!(outcome, Outcome::Done);
    assert!(matches!(events.last(), Some(AiEvent::Done { .. })));
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(!alive(pid_file(&stub, "pid")));
    assert_gone(pid_file(&stub, "child-pid"), "claude's child");
}

#[test]
fn status_reads_the_version() {
    assert_eq!(
        stub("answer").driver.status(),
        Status {
            installed: true,
            version: Some("9.8.7".into())
        }
    );
    assert_eq!(
        stub("version-odd").driver.status(),
        Status {
            installed: true,
            version: None
        }
    );
    let missing = Status {
        installed: false,
        version: None,
    };
    assert_eq!(stub("version-fail").driver.status(), missing);
    let mut gone = stub("answer");
    gone.driver.bin = PathBuf::from("/nonexistent/claude");
    assert_eq!(gone.driver.status(), missing);
    // Asking for the version starts no session: the stub recorded no run.
    let stub = stub("answer");
    stub.driver.status();
    assert!(!stub.record.join("argv").exists());
}
