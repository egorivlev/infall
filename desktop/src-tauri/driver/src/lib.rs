//! Runs the Member's own `claude` (Claude Code) for one AI sidebar turn, as
//! docs/specs/desktop.md describes: print mode, in an empty temporary directory, with only the
//! Qoop tools, the access token in an owner-only file, and the output mapped to [`AiEvent`]s.
//!
//! There are no Tauri types here. The app is a thin adapter over [`Driver`].
//!
//! The driver sends nothing anywhere itself and never reads Claude Code's credentials: only
//! the `claude` process talks to Anthropic, under the Member's own login.

mod args;
mod events;

use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

pub use args::{
    CHILD_ENV, MCP_SERVER_NAME, QOOP_TOOLS, allowed_tools, build_args, mcp_config_json,
};
pub use events::{AiEvent, StreamParser, TOOL_PREFIX};

/// The environment variable that overrides where `claude` is (used by tests with a stub).
pub const BIN_ENV: &str = "QOOP_CLAUDE_BIN";

/// A run with no output for this long is stopped with an `error`.
pub const SILENCE_TIMEOUT: Duration = Duration::from_secs(120);

/// One line of output longer than this is skipped rather than held in memory.
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

/// A value that must never be printed: `Debug` shows a placeholder.
#[derive(Clone)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The value itself. Only for writing the MCP config file.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[secret]")
    }
}

/// One turn.
#[derive(Debug, Clone)]
pub struct RunRequest {
    /// The Member's message; sent on standard input.
    pub prompt: String,
    /// Appended to the system prompt.
    pub system: String,
    /// A session id from an earlier `done`.
    pub resume: Option<String>,
    /// The server's `/mcp` endpoint.
    pub tools_url: String,
    /// The access token for it; written only to the owner-only MCP config file.
    pub tools_token: Secret,
}

/// How a run ended. The matching `done`/`error` event has already been delivered;
/// a cancelled run delivers no further event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Done,
    Failed,
    Cancelled,
}

/// Whether `claude` is available on this machine.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Status {
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

enum Msg {
    Line(String),
    Eof,
    Cancel,
}

/// Stops a run from another thread. Cloneable; cancelling before the run starts also works.
#[derive(Clone, Default)]
pub struct Cancel {
    inner: Arc<CancelInner>,
}

#[derive(Default)]
struct CancelInner {
    cancelled: AtomicBool,
    wake: Mutex<Option<Sender<Msg>>>,
}

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }

    /// Ends the run: the process and its children are terminated by the running thread.
    pub fn cancel(&self) {
        self.inner.cancelled.store(true, Ordering::SeqCst);
        if let Some(wake) = self.inner.wake.lock().unwrap().as_ref() {
            let _ = wake.send(Msg::Cancel);
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    fn attach(&self, wake: Sender<Msg>) {
        let mut slot = self.inner.wake.lock().unwrap();
        if self.is_cancelled() {
            let _ = wake.send(Msg::Cancel);
        }
        *slot = Some(wake);
    }

    fn detach(&self) {
        *self.inner.wake.lock().unwrap() = None;
    }
}

/// How to run `claude`.
#[derive(Debug, Clone)]
pub struct Driver {
    /// The `claude` program.
    pub bin: PathBuf,
    /// Stop a run that has printed nothing for this long.
    pub silence_timeout: Duration,
    /// How long `claude` gets to exit by itself once its result has arrived.
    pub exit_grace: Duration,
    /// How long the process gets to stop after a polite request, before it is killed.
    pub kill_grace: Duration,
    /// An owner-only directory holding the run's empty working directory and its MCP config
    /// file. The working directory is `<work_root>/cwd`: emptied before and after every run,
    /// but at a stable path, because Claude Code finds a session to resume by the directory
    /// it was started in.
    pub work_root: PathBuf,
    /// Extra environment variables for the child (tests use this to steer the stub).
    pub env: Vec<(OsString, OsString)>,
}

impl Driver {
    pub fn new(bin: impl Into<PathBuf>) -> Self {
        Self {
            bin: bin.into(),
            silence_timeout: SILENCE_TIMEOUT,
            exit_grace: Duration::from_secs(3),
            kill_grace: Duration::from_millis(1500),
            work_root: default_work_root(),
            env: Vec::new(),
        }
    }

    /// Is `claude` there, and which version (`claude --version`; no session is started).
    pub fn status(&self) -> Status {
        let missing = Status {
            installed: false,
            version: None,
        };
        let mut command = Command::new(&self.bin);
        command
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .envs(self.env.iter().map(|(k, v)| (k, v)));
        own_process_group(&mut command);
        let Ok(child) = command.spawn() else {
            return missing;
        };
        let mut child = Group::new(child);
        let Some(mut stdout) = child.child.stdout.take() else {
            return missing;
        };
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let mut text = String::new();
            let _ = stdout.by_ref().take(4096).read_to_string(&mut text);
            let _ = tx.send(text);
        });
        let Ok(text) = rx.recv_timeout(Duration::from_secs(10)) else {
            return missing;
        };
        let ok = child.finish(self.exit_grace).is_some_and(|s| s.success());
        if !ok {
            return missing;
        }
        Status {
            installed: true,
            version: parse_version(&text),
        }
    }

    /// Runs one turn to its end, calling `on_event` for every event, in order, on this
    /// thread. Blocks until the process is gone and the temporary files are deleted.
    pub fn run(
        &self,
        request: &RunRequest,
        cancel: &Cancel,
        on_event: &mut dyn FnMut(AiEvent),
    ) -> Outcome {
        if cancel.is_cancelled() {
            return Outcome::Cancelled;
        }
        let mut fail = |message: &str| {
            on_event(AiEvent::Error {
                message: message.to_owned(),
            });
            Outcome::Failed
        };

        let prepared = prepare_root(&self.work_root)
            .and_then(|()| fresh_dir(&self.work_root.join("cwd")))
            .and_then(|cwd| Ok((McpFile::create(&self.work_root, request)?, cwd)));
        let (mcp_file, cwd) = match prepared {
            Ok(prepared) => prepared,
            Err(_) => return fail("Qoop could not prepare a temporary folder for Claude Code."),
        };
        // Dropped in reverse order at every exit: first the process group (`child`, below),
        // then the working directory is emptied, then the MCP config file is deleted.
        let _cleanup = Cleanup { cwd: cwd.clone() };

        let mut command = Command::new(&self.bin);
        command
            .args(build_args(request, &mcp_file.path))
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .envs(CHILD_ENV)
            .envs(self.env.iter().map(|(k, v)| (k, v)));
        own_process_group(&mut command);
        let child = match command.spawn() {
            Ok(child) => child,
            Err(_) => return fail("Claude Code could not be started on this machine."),
        };
        let mut child = Group::new(child);

        let (tx, rx) = mpsc::channel::<Msg>();
        cancel.attach(tx.clone());

        if let Some(mut stdin) = child.child.stdin.take() {
            let prompt = request.prompt.clone();
            thread::spawn(move || {
                let _ = stdin.write_all(prompt.as_bytes());
                // Dropping `stdin` closes it: the prompt is complete.
            });
        }
        if let Some(mut stderr) = child.child.stderr.take() {
            // Drained so the child never blocks on it; never logged or shown.
            thread::spawn(move || {
                let _ = io::copy(&mut stderr, &mut io::sink());
            });
        }
        if let Some(stdout) = child.child.stdout.take() {
            thread::spawn(move || read_lines(stdout, &tx));
        }

        let mut parser = StreamParser::new();
        let token = request.tools_token.expose();
        let outcome = loop {
            match rx.recv_timeout(self.silence_timeout) {
                Ok(Msg::Line(line)) => {
                    let mut ended = None;
                    for event in parser.feed(&line) {
                        let event = redact(event, token);
                        match &event {
                            AiEvent::Done { .. } => ended = Some(Outcome::Done),
                            AiEvent::Error { .. } => ended = Some(Outcome::Failed),
                            _ => {}
                        }
                        on_event(event);
                    }
                    if let Some(outcome) = ended {
                        child.finish(self.exit_grace);
                        break outcome;
                    }
                }
                Ok(Msg::Eof) => {
                    let status = child.finish(self.exit_grace);
                    let message = match status.and_then(|s| s.code()) {
                        Some(code) if code != 0 => format!(
                            "Claude Code stopped before finishing the answer (exit code {code})."
                        ),
                        _ => "Claude Code stopped before finishing the answer.".to_owned(),
                    };
                    on_event(AiEvent::Error { message });
                    break Outcome::Failed;
                }
                Ok(Msg::Cancel) => {
                    child.terminate(self.kill_grace);
                    break Outcome::Cancelled;
                }
                Err(RecvTimeoutError::Timeout) => {
                    child.terminate(self.kill_grace);
                    on_event(AiEvent::Error {
                        message: format!(
                            "Claude Code gave no output for {} seconds, so the run was stopped.",
                            self.silence_timeout.as_secs()
                        ),
                    });
                    break Outcome::Failed;
                }
                Err(RecvTimeoutError::Disconnected) => {
                    // Cannot happen while `cancel` holds a sender; treat as the stream ending.
                    child.terminate(self.kill_grace);
                    on_event(AiEvent::Error {
                        message: "Claude Code stopped before finishing the answer.".to_owned(),
                    });
                    break Outcome::Failed;
                }
            }
        };
        cancel.detach();
        outcome
    }
}

/// Where `claude` is: the `QOOP_CLAUDE_BIN` override if set, else the first `claude` found
/// on `PATH` or in the usual install places (an app started from the Finder gets a short
/// `PATH`, so those are checked too).
pub fn locate() -> Option<PathBuf> {
    locate_in(
        std::env::var_os(BIN_ENV).as_deref(),
        std::env::var_os("PATH").as_deref(),
        std::env::var_os("HOME").as_deref().map(Path::new),
    )
}

/// [`locate`] with its inputs explicit.
pub fn locate_in(
    override_bin: Option<&OsStr>,
    path: Option<&OsStr>,
    home: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(bin) = override_bin
        && !bin.is_empty()
    {
        return Some(PathBuf::from(bin));
    }
    let name = if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    };
    let mut dirs: Vec<PathBuf> = path
        .map(|p| std::env::split_paths(p).collect())
        .unwrap_or_default();
    if let Some(home) = home {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".claude/local"));
    }
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs.into_iter()
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable_file(candidate))
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
    }
}

/// `2.1.265 (Claude Code)` → `2.1.265`.
fn parse_version(text: &str) -> Option<String> {
    let word = text.split_whitespace().next()?;
    let plausible = word.len() <= 40
        && word.starts_with(|c: char| c.is_ascii_digit())
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
    plausible.then(|| word.to_owned())
}

/// Replaces the token, should Claude Code ever echo it, before an event leaves the driver.
fn redact(event: AiEvent, token: &str) -> AiEvent {
    if token.is_empty() {
        return event;
    }
    let clean = |s: String| {
        if s.contains(token) {
            s.replace(token, "[token]")
        } else {
            s
        }
    };
    match event {
        AiEvent::Error { message } => AiEvent::Error {
            message: clean(message),
        },
        AiEvent::Delta { text } => AiEvent::Delta { text: clean(text) },
        other => other,
    }
}

/// Sends each line of `stdout` (without its newline), then `Eof`.
fn read_lines(stdout: impl Read, tx: &Sender<Msg>) {
    let mut reader = BufReader::new(stdout);
    let mut buf = Vec::new();
    let mut skipping = false;
    loop {
        buf.clear();
        let read = reader
            .by_ref()
            .take(MAX_LINE_BYTES as u64)
            .read_until(b'\n', &mut buf);
        match read {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let complete = buf.last() == Some(&b'\n');
                if skipping || !complete && buf.len() >= MAX_LINE_BYTES {
                    // Part of an overlong line: drop it, up to and including its newline.
                    skipping = !complete;
                    continue;
                }
                let line = String::from_utf8_lossy(&buf);
                if tx.send(Msg::Line(line.trim_end().to_owned())).is_err() {
                    return;
                }
            }
        }
    }
    let _ = tx.send(Msg::Eof);
}

// ---- temporary files -------------------------------------------------------------------

fn default_work_root() -> PathBuf {
    #[cfg(unix)]
    // SAFETY: `geteuid` has no preconditions and cannot fail.
    let who = unsafe { libc::geteuid() }.to_string();
    #[cfg(not(unix))]
    let who = String::from("user");
    std::env::temp_dir().join(format!("qoop-desktop-claude-{who}"))
}

/// Makes sure `root` is a real directory that belongs to this user and nobody else can enter.
fn prepare_root(root: &Path) -> io::Result<()> {
    make_private_dir(root)?;
    let meta = fs::symlink_metadata(root)?;
    if !meta.is_dir() {
        return Err(io::Error::other("the work folder is not a directory"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // SAFETY: `geteuid` has no preconditions and cannot fail.
        if meta.uid() != unsafe { libc::geteuid() } {
            return Err(io::Error::other("the work folder belongs to someone else"));
        }
        fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
    }
    // Config files a crashed run could not delete.
    for entry in fs::read_dir(root)?.flatten() {
        let name = entry.file_name();
        let stale = name.to_string_lossy().starts_with("mcp-")
            && entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|at| SystemTime::now().duration_since(at).ok())
                .is_some_and(|age| age > Duration::from_secs(600));
        if stale {
            let _ = fs::remove_file(entry.path());
        }
    }
    Ok(())
}

fn make_private_dir(dir: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

fn remove_any(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Removes whatever is at `dir` and creates it again, empty and owner-only.
fn fresh_dir(dir: &Path) -> io::Result<PathBuf> {
    remove_any(dir)?;
    make_private_dir(dir)?;
    Ok(dir.to_owned())
}

/// The MCP config file holding the token: created owner-only, deleted when dropped.
struct McpFile {
    path: PathBuf,
}

impl McpFile {
    fn create(root: &Path, request: &RunRequest) -> io::Result<Self> {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let path = root.join(format!(
            "mcp-{}-{}-{}.json",
            std::process::id(),
            nanos,
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let mut options = fs::OpenOptions::new();
        // `create_new`: never write through something that is already there.
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path)?;
        let guard = Self { path };
        file.write_all(mcp_config_json(request).as_bytes())?;
        file.sync_all()?;
        Ok(guard)
    }
}

impl Drop for McpFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

/// Empties the run's working directory when dropped.
struct Cleanup {
    cwd: PathBuf,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = fresh_dir(&self.cwd);
    }
}

// ---- the process group ------------------------------------------------------------------

/// Puts the child in a process group of its own, so that it and everything it starts can be
/// signalled together.
fn own_process_group(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(not(unix))]
    let _ = command;
}

/// A child that leads its own process group. Dropping it kills the whole group.
struct Group {
    child: Child,
    reaped: bool,
}

impl Group {
    fn new(child: Child) -> Self {
        Self {
            child,
            reaped: false,
        }
    }

    /// Signals the whole group. Only called while the leader has not been reaped, so the
    /// group id cannot have been reused for another process.
    #[cfg(unix)]
    fn signal(&self, signal: libc::c_int) {
        let Ok(pid) = libc::pid_t::try_from(self.child.id()) else {
            return;
        };
        if pid > 1 {
            // SAFETY: `kill` with a negative pid signals a process group; it touches no
            // memory. An error (the group is already gone) is fine to ignore.
            unsafe {
                libc::kill(-pid, signal);
            }
        }
    }

    /// Has the leader exited? Looks without reaping it, so its id stays reserved.
    #[cfg(unix)]
    fn exited(&self) -> bool {
        let pid = libc::id_t::from(self.child.id());
        // SAFETY: `info` is a valid, zeroed `siginfo_t` that `waitid` only writes to.
        // `WNOWAIT` leaves the child waitable for `Child::wait`.
        unsafe {
            let mut info: libc::siginfo_t = std::mem::zeroed();
            let result = libc::waitid(
                libc::P_PID,
                pid,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            );
            result != 0 || info.si_pid() != 0
        }
    }

    fn wait_exit(&self, grace: Duration) {
        #[cfg(unix)]
        {
            let deadline = Instant::now() + grace;
            while !self.exited() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
        }
        #[cfg(not(unix))]
        let _ = (grace, Instant::now());
    }

    fn kill_and_reap(&mut self) -> Option<ExitStatus> {
        if self.reaped {
            return None;
        }
        #[cfg(unix)]
        self.signal(libc::SIGKILL);
        #[cfg(not(unix))]
        let _ = self.child.kill();
        self.reaped = true;
        self.child.wait().ok()
    }

    /// The run is over: give the process `grace` to exit by itself, then remove whatever is
    /// left of its group. Returns the leader's exit status.
    fn finish(&mut self, grace: Duration) -> Option<ExitStatus> {
        if self.reaped {
            return None;
        }
        self.wait_exit(grace);
        self.kill_and_reap()
    }

    /// Stop now: ask politely, wait `grace`, then kill the whole group.
    fn terminate(&mut self, grace: Duration) {
        if self.reaped {
            return;
        }
        #[cfg(unix)]
        self.signal(libc::SIGTERM);
        self.wait_exit(grace);
        self.kill_and_reap();
    }
}

impl Drop for Group {
    fn drop(&mut self) {
        self.kill_and_reap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_is_never_printed() {
        let request = RunRequest {
            prompt: "p".into(),
            system: "s".into(),
            resume: None,
            tools_url: "http://localhost:8787/mcp".into(),
            tools_token: Secret::new("qoop_pat_TOPSECRET"),
        };
        let printed = format!("{request:?} {:#?}", request.tools_token);
        assert!(!printed.contains("TOPSECRET"));
        assert!(printed.contains("[secret]"));
    }

    #[test]
    fn version_text() {
        assert_eq!(
            parse_version("2.1.265 (Claude Code)\n").as_deref(),
            Some("2.1.265")
        );
        assert_eq!(
            parse_version("1.0.0-beta.2").as_deref(),
            Some("1.0.0-beta.2")
        );
        assert_eq!(parse_version("Claude Code"), None);
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("1.0<script>"), None);
    }

    #[test]
    fn the_token_is_removed_from_events() {
        let event = redact(
            AiEvent::Error {
                message: "bad header Bearer abc123".into(),
            },
            "abc123",
        );
        assert_eq!(
            event,
            AiEvent::Error {
                message: "bad header Bearer [token]".into()
            }
        );
    }

    #[test]
    fn overlong_lines_are_skipped_and_the_rest_still_read() {
        let mut data = vec![b'x'; MAX_LINE_BYTES + 10];
        data.extend_from_slice(b"\nshort\nlast");
        let (tx, rx) = mpsc::channel();
        read_lines(&data[..], &tx);
        let lines: Vec<String> = rx
            .try_iter()
            .filter_map(|m| match m {
                Msg::Line(l) => Some(l),
                _ => None,
            })
            .collect();
        assert_eq!(lines, vec!["short", "last"]);
    }

    #[test]
    fn locating_claude() {
        let dir = tempfile::tempdir().unwrap();
        // The override wins, whatever it points at.
        assert_eq!(
            locate_in(Some(OsStr::new("/x/stub")), None, None),
            Some(PathBuf::from("/x/stub"))
        );
        // An empty override is no override; nothing on this PATH.
        let path = std::env::join_paths([dir.path()]).unwrap();
        let found = locate_in(Some(OsStr::new("")), Some(&path), Some(dir.path()));
        assert!(found.is_none_or(|p| !p.starts_with(dir.path())));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let bin = dir.path().join("claude");
            fs::write(&bin, "#!/bin/sh\n").unwrap();
            // Not executable: not found.
            let found = locate_in(None, Some(&path), None);
            assert!(found.is_none_or(|p| p != bin));
            fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(locate_in(None, Some(&path), None), Some(bin));
            // Found in ~/.local/bin when PATH is short.
            let home = tempfile::tempdir().unwrap();
            fs::create_dir_all(home.path().join(".local/bin")).unwrap();
            let bin = home.path().join(".local/bin/claude");
            fs::write(&bin, "#!/bin/sh\n").unwrap();
            fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
            let empty = tempfile::tempdir().unwrap();
            let path = std::env::join_paths([empty.path()]).unwrap();
            assert_eq!(locate_in(None, Some(&path), Some(home.path())), Some(bin));
        }
    }
}
