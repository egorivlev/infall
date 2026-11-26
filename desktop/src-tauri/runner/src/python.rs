//! Finding and checking Python interpreters, and the environment Runs get.
//!
//! An app started from the Finder or a launcher has a bare `PATH`, so interpreters are looked
//! up the way the Member's own shell would find them: the shell is started once as a login
//! shell and asked for its environment.

use std::ffi::{OsStr, OsString};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use infall_proc::{Group, is_executable_file, own_process_group, own_session};

pub use crate::settings::Interpreter;

/// Environment variables, as a process gets them.
pub type EnvVars = Vec<(OsString, OsString)>;

/// How long `<path> --version` gets to answer.
pub const VERSION_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(unix)]
const SHELL_TIMEOUT: Duration = Duration::from_secs(8);
/// At most this many candidates are started when looking for interpreters.
const MAX_CANDIDATES: usize = 12;

#[cfg(unix)]
const ENV_MARKER: &[u8] = b"\n__INFALL_ENV_BEGIN__\n";

/// Runs `command` to its end and returns whether it succeeded and what it printed (at most
/// `limit` bytes). `None` if it could not be started or did not end within `timeout`; it
/// and everything it started are killed either way.
pub(crate) fn capture(
    command: Command,
    timeout: Duration,
    limit: usize,
    with_stderr: bool,
    session: bool,
) -> Option<(bool, Vec<u8>)> {
    capture_status(command, timeout, limit, with_stderr, session)
        .ok()
        .map(|(status, out)| (status.success(), out))
}

/// Why [`capture_status`] has no exit status to give.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NoStatus {
    NotStarted,
    TimedOut,
}

/// As [`capture`], with how the program ended: its exit status, or why there is none.
pub(crate) fn capture_status(
    mut command: Command,
    timeout: Duration,
    limit: usize,
    with_stderr: bool,
    session: bool,
) -> Result<(ExitStatus, Vec<u8>), NoStatus> {
    let (mut reader, writer) = io::pipe().map_err(|_| NoStatus::NotStarted)?;
    command.stdin(Stdio::null());
    if with_stderr {
        command.stderr(writer.try_clone().map_err(|_| NoStatus::NotStarted)?);
    } else {
        command.stderr(Stdio::null());
    }
    command.stdout(writer);
    if session {
        own_session(&mut command);
    } else {
        own_process_group(&mut command);
    }
    let child = command.spawn().map_err(|_| NoStatus::NotStarted)?;
    // The command holds the writing ends of the pipe; without this the reader never ends.
    drop(command);
    let mut group = Group::new(child);

    let (tx, rx) = mpsc::sync_channel::<Option<Vec<u8>>>(8);
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(Some(buffer[..n].to_vec())).is_err() {
                        return;
                    }
                }
            }
        }
        let _ = tx.send(None);
    });

    let deadline = Instant::now() + timeout;
    let mut out = Vec::new();
    let mut eof = false;
    let mut exited: Option<Instant> = None;
    loop {
        if eof {
            thread::sleep(Duration::from_millis(10));
        } else {
            match rx.recv_timeout(Duration::from_millis(10)) {
                Ok(Some(chunk)) => {
                    let room = limit.saturating_sub(out.len());
                    out.extend_from_slice(&chunk[..chunk.len().min(room)]);
                }
                Ok(None) | Err(RecvTimeoutError::Disconnected) => eof = true,
                Err(RecvTimeoutError::Timeout) => {}
            }
        }
        let now = Instant::now();
        if exited.is_none() && group.exited() {
            exited = Some(now);
        }
        match exited {
            Some(_) if eof => break,
            // Something it started still holds the pipe open: do not wait for it.
            Some(at) if now.duration_since(at) > Duration::from_millis(300) => break,
            _ => {}
        }
        if now > deadline {
            return Err(NoStatus::TimedOut);
        }
    }
    let status = group.kill_and_reap().ok_or(NoStatus::NotStarted)?;
    Ok((status, out))
}

// ---- the login shell's environment --------------------------------------------------------

#[cfg(unix)]
fn parse_env(output: &[u8]) -> Option<EnvVars> {
    let start = output
        .windows(ENV_MARKER.len())
        .rposition(|w| w == ENV_MARKER)?
        + ENV_MARKER.len();
    let mut vars = EnvVars::new();
    for entry in output[start..].split(|b| *b == 0) {
        let Some(eq) = entry.iter().position(|b| *b == b'=') else {
            continue;
        };
        if eq == 0 {
            continue;
        }
        vars.push((os_string(&entry[..eq]), os_string(&entry[eq + 1..])));
    }
    let has_path = vars.iter().any(|(k, v)| k == "PATH" && !v.is_empty());
    has_path.then_some(vars)
}

#[cfg(unix)]
fn os_string(bytes: &[u8]) -> OsString {
    use std::os::unix::ffi::OsStrExt;
    OsStr::from_bytes(bytes).to_owned()
}

/// Variables that describe the shell that was asked, not the Member's setup.
fn tidy(mut vars: EnvVars) -> EnvVars {
    vars.retain(|(k, _)| !["PWD", "OLDPWD", "SHLVL", "_"].iter().any(|skip| k == skip));
    vars
}

#[cfg(unix)]
fn shell_env(shell: &Path, flags: &[&str]) -> Option<EnvVars> {
    let mut command = Command::new(shell);
    command
        .args(flags)
        .arg("printf '\\n%s\\n' __INFALL_ENV_BEGIN__; exec /usr/bin/env -0")
        .current_dir(std::env::temp_dir());
    let (ok, output) = capture(command, SHELL_TIMEOUT, 1 << 20, false, true)?;
    if !ok {
        return None;
    }
    parse_env(&output)
}

/// The environment the Member's shell gives to programs: `PATH` with pyenv, conda, Homebrew
/// and whatever else their shell sets up. Asked of `$SHELL` started as an interactive login
/// shell (many set-ups put pyenv or conda into the file only interactive shells read), then
/// as a plain login shell; if neither answers, the app's own environment. On Windows it is
/// always the app's own environment: a program started from the Start menu already has the
/// Member's whole `PATH` there.
pub fn login_env() -> EnvVars {
    #[cfg(unix)]
    {
        let shell = std::env::var_os("SHELL")
            .map(PathBuf::from)
            .filter(|s| s.is_absolute() && is_executable_file(s))
            .or_else(|| {
                ["/bin/zsh", "/bin/bash", "/bin/sh"]
                    .iter()
                    .map(PathBuf::from)
                    .find(|s| is_executable_file(s))
            });
        if let Some(shell) = shell {
            for flags in [&["-l", "-i", "-c"][..], &["-l", "-c"][..]] {
                if let Some(vars) = shell_env(&shell, flags) {
                    return tidy(vars);
                }
            }
        }
    }
    tidy(std::env::vars_os().collect())
}

// ---- interpreters --------------------------------------------------------------------------

/// `Python 3.12.3` → `3.12.3`. Anything that is not Python 3 is `None`.
pub fn parse_version(output: &str) -> Option<String> {
    let rest = output.trim_start().strip_prefix("Python ")?;
    let word = rest.split_whitespace().next()?;
    let plausible = word.starts_with("3.")
        && word.len() <= 40
        && word[2..].starts_with(|c: char| c.is_ascii_digit())
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
    plausible.then(|| word.to_owned())
}

/// `~/x` → `<home>/x`.
fn expand_home(path: &str, env: &EnvVars) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/")
        && let Some(home) = home_dir(env)
    {
        return Path::new(home).join(rest);
    }
    PathBuf::from(path)
}

fn python_command(path: &Path, env: &EnvVars) -> Command {
    let mut command = Command::new(path);
    command
        .env_clear()
        .envs(env.iter().map(|(k, v)| (k, v)))
        .current_dir(std::env::temp_dir());
    command
}

/// Checks a path the Member typed: it must be the full path of a program that answers
/// `--version` like Python 3, within [`VERSION_TIMEOUT`]. The error is a plain sentence.
pub fn validate(path: &str, env: &EnvVars) -> Result<Interpreter, String> {
    let typed = path.trim();
    if typed.is_empty() {
        return Err("Enter the full path of a Python 3 interpreter.".into());
    }
    let path = expand_home(typed, env);
    if !path.is_absolute() || typed.contains('\0') {
        return Err(if cfg!(windows) {
            "Enter the full path, starting with the drive (C:\\…)."
        } else {
            "Enter the full path, starting with /."
        }
        .into());
    }
    if path.is_dir() {
        return Err("That is a folder. Enter the path of the Python program itself.".into());
    }
    if !is_executable_file(&path) {
        return Err("There is no program at that path.".into());
    }
    let Some(shown) = path.to_str() else {
        return Err("That path cannot be used.".into());
    };
    let mut command = python_command(&path, env);
    command.arg("--version");
    let answer = capture(command, VERSION_TIMEOUT, 4096, true, false);
    let version = answer
        .filter(|(ok, _)| *ok)
        .and_then(|(_, out)| parse_version(&String::from_utf8_lossy(&out)));
    match version {
        Some(version) => Ok(Interpreter {
            path: shown.to_owned(),
            version,
        }),
        None => Err("That program did not answer like Python 3.".into()),
    }
}

const PROBE: &str = "import os,sys;v=sys.version_info;print('INFALL %d.%d.%d'%(v[0],v[1],v[2]));\
print(sys.executable);print(os.path.realpath(sys.executable));print(sys.prefix)";

/// Asks a candidate what it really is: the interpreter behind a shim or a link, its version,
/// and a key that is the same for two names of the same interpreter.
fn probe(path: &Path, env: &EnvVars) -> Option<(Interpreter, String)> {
    let mut command = python_command(path, env);
    command.args(["-I", "-c", PROBE]);
    let (ok, out) = capture(command, VERSION_TIMEOUT, 16_384, false, false)?;
    if !ok {
        return None;
    }
    let text = String::from_utf8(out).ok()?;
    let mut lines = text.lines().skip_while(|l| !l.starts_with("INFALL "));
    let version = parse_version(&lines.next()?.replacen("INFALL", "Python", 1))?;
    let executable = lines.next()?.trim();
    let real = lines.next()?.trim();
    let prefix = lines.next()?.trim();
    if !Path::new(executable).is_absolute() || !is_executable_file(Path::new(executable)) {
        return None;
    }
    Some((
        Interpreter {
            path: executable.to_owned(),
            version,
        },
        // A virtual environment shares its program with the Python it was made from, but
        // not its prefix.
        format!("{real}\n{prefix}"),
    ))
}

// (One line per `concat!` part: a `\` line continuation would eat the indentation.)
const QSHARP_PROBE: &str = concat!(
    "import importlib.metadata as m, sys\n",
    "print('INFALL %d.%d' % sys.version_info[:2])\n",
    "for d in ('qdk', 'qsharp'):\n",
    "    try:\n",
    "        print('INFALL', d, m.version(d))\n",
    "        break\n",
    "    except Exception:\n",
    "        pass\n",
);

/// Asks an interpreter (`-I`, five seconds) which distribution would run Q# there: the
/// version of its `qdk`, and only when there is none, of its `qsharp` (one of 1.28 or
/// earlier is the package itself; a later one is a shim over `qdk`, whose version says
/// nothing). The error is a plain sentence saying what to install.
pub fn qsharp_probe(path: &Path, env: &EnvVars) -> Result<crate::settings::Qsharp, String> {
    let mut command = python_command(path, env);
    command.args(["-I", "-c", QSHARP_PROBE]);
    let answer = capture(command, VERSION_TIMEOUT, 4096, false, false)
        .filter(|(ok, _)| *ok)
        .and_then(|(_, out)| String::from_utf8(out).ok())
        .ok_or_else(|| {
            "The chosen Python did not answer. Check it in the list above.".to_owned()
        })?;
    let mut lines = answer.lines().filter_map(|l| l.strip_prefix("INFALL "));
    let old = lines
        .next()
        .and_then(|v| v.split_once('.'))
        .and_then(|(major, minor)| Some((major.parse::<u32>().ok()?, minor.parse::<u32>().ok()?)))
        .is_some_and(|v| v < (3, 10));
    if let Some((package, version)) = lines.next().and_then(|l| l.split_once(' '))
        && matches!(package, "qdk" | "qsharp")
        && crate::toolchains::short_plain(version, 40)
    {
        return Ok(crate::settings::Qsharp {
            package: package.to_owned(),
            version: version.to_owned(),
            off: false,
        });
    }
    Err(if old {
        "Q# needs Python 3.10 or newer, and the chosen Python is older. Choose a newer one, then \
         install Q# into it with: pip install qdk"
    } else {
        "Q# is not installed for the chosen Python. Install it into that Python with: \
         pip install qdk (it needs Python 3.10 or newer)."
    }
    .to_owned())
}

/// The names an interpreter goes by in a directory. Windows: `py.exe` is the launcher
/// python.org's installer adds; asked what it is, it answers for the Python it would start.
const NAMES: &[&str] = if cfg!(windows) {
    &["python.exe", "python3.exe", "py.exe"]
} else {
    &["python3", "python"]
};

/// The directories to look in: the shell's `PATH`, then the usual places.
fn search_dirs(env: &EnvVars) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = env_value(env, "PATH")
        .map(|p| std::env::split_paths(p).collect())
        .unwrap_or_default();
    if cfg!(windows) {
        // Where python.org's installer puts a Python for one person (`Python312`, …; it is
        // only on `PATH` if the box was ticked), newest first, and its launcher.
        if let Some(local) = env_value(env, "LOCALAPPDATA") {
            let root = Path::new(local).join("Programs").join("Python");
            let mut versions: Vec<String> = std::fs::read_dir(&root)
                .into_iter()
                .flatten()
                .flatten()
                .filter_map(|entry| entry.file_name().into_string().ok())
                .filter(|name| name.starts_with("Python3"))
                .collect();
            versions.sort_by(|a, b| (b.len(), b).cmp(&(a.len(), a)));
            dirs.extend(versions.iter().map(|name| root.join(name)));
            dirs.push(root.join("Launcher"));
        }
    } else {
        if let Some(home) = home_dir(env) {
            dirs.push(Path::new(home).join(".pyenv/shims"));
        }
        for usual in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
            dirs.push(PathBuf::from(usual));
        }
    }
    dirs.retain(|d| d.is_absolute());
    dirs
}

/// The Python 3 interpreters a shell would find as `python3` or `python`, each once.
pub fn find(env: &EnvVars) -> Vec<Interpreter> {
    let mut tried: Vec<PathBuf> = Vec::new();
    let mut keys: Vec<String> = Vec::new();
    let mut found = Vec::new();
    'search: for dir in search_dirs(env) {
        for name in NAMES {
            let candidate = dir.join(name);
            if !is_executable_file(&candidate) {
                continue;
            }
            let real = candidate
                .canonicalize()
                .unwrap_or_else(|_| candidate.clone());
            if tried.contains(&real) {
                continue;
            }
            if tried.len() == MAX_CANDIDATES {
                break 'search;
            }
            tried.push(real);
            if let Some((interpreter, key)) = probe(&candidate, env)
                && !keys.contains(&key)
            {
                keys.push(key);
                found.push(interpreter);
            }
        }
    }
    found
}

/// A value of `env`. Windows does not tell `Path` from `PATH`, so neither does this there.
pub fn env_value<'a>(env: &'a EnvVars, name: &str) -> Option<&'a OsStr> {
    env.iter()
        .find(|(k, _)| {
            if cfg!(windows) {
                k.to_str().is_some_and(|k| k.eq_ignore_ascii_case(name))
            } else {
                k == name
            }
        })
        .map(|(_, v)| v.as_os_str())
}

/// The Member's home folder according to `env`.
pub fn home_dir(env: &EnvVars) -> Option<&OsStr> {
    env_value(env, if cfg!(windows) { "USERPROFILE" } else { "HOME" })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn own_env() -> EnvVars {
        std::env::vars_os().collect()
    }

    #[test]
    fn version_answers() {
        assert_eq!(parse_version("Python 3.12.3\n").as_deref(), Some("3.12.3"));
        assert_eq!(parse_version("Python 3.8.0").as_deref(), Some("3.8.0"));
        assert_eq!(
            parse_version("  Python 3.13.0rc1+ (extra)").as_deref(),
            Some("3.13.0rc1+")
        );
        for other in [
            "",
            "Python",
            "Python 2.7.18",
            "Python 4.0.0",
            "Python 3",
            "Python 3.",
            "Python 3.x",
            "python 3.12.3",
            "Pythonista 3.12.3",
            "3.12.3",
            "Ruby 3.3.0",
            "Python 3.12<script>",
            "error: Python 3.12.3",
        ] {
            assert_eq!(parse_version(other), None, "{other:?}");
        }
        assert_eq!(parse_version(&format!("Python 3.{}", "1".repeat(60))), None);
    }

    #[test]
    fn a_typed_path_must_answer_like_python_3() {
        let dir = tempfile::tempdir().unwrap();
        let env = own_env();
        let good = script(dir.path(), "good", "echo 'Python 3.11.4'");
        assert_eq!(
            validate(good.to_str().unwrap(), &env),
            Ok(Interpreter {
                path: good.to_str().unwrap().to_owned(),
                version: "3.11.4".into()
            })
        );
        // Spaces around what was typed are not part of the path.
        assert!(validate(&format!("  {}\n", good.display()), &env).is_ok());
        // Only `--version` is asked.
        let strict = script(
            dir.path(),
            "strict",
            "[ \"$#\" = 1 ] && [ \"$1\" = --version ] && echo 'Python 3.9.1'",
        );
        assert!(validate(strict.to_str().unwrap(), &env).is_ok());

        let refused = |path: &Path| validate(path.to_str().unwrap(), &env).unwrap_err();
        let not_python = "That program did not answer like Python 3.";
        assert_eq!(
            refused(&script(dir.path(), "two", "echo 'Python 2.7.18' >&2")),
            not_python
        );
        assert_eq!(
            refused(&script(dir.path(), "ruby", "echo 'ruby 3.3.0'")),
            not_python
        );
        assert_eq!(refused(&script(dir.path(), "silent", "true")), not_python);
        // The right words but a failing exit code.
        assert_eq!(
            refused(&script(dir.path(), "fails", "echo 'Python 3.12.0'; exit 3")),
            not_python
        );
        // Not a program at all.
        let text = dir.path().join("notes.txt");
        fs::write(&text, "Python 3.12.0").unwrap();
        assert_eq!(refused(&text), "There is no program at that path.");
        assert_eq!(
            refused(&dir.path().join("missing")),
            "There is no program at that path."
        );
        assert_eq!(
            refused(dir.path()),
            "That is a folder. Enter the path of the Python program itself."
        );
        assert_eq!(
            validate("python3", &env).unwrap_err(),
            "Enter the full path, starting with /."
        );
        assert_eq!(
            validate("./python3", &env).unwrap_err(),
            "Enter the full path, starting with /."
        );
        assert_eq!(
            validate("   ", &env).unwrap_err(),
            "Enter the full path of a Python 3 interpreter."
        );
    }

    #[test]
    fn a_program_that_never_answers_is_given_up_on_and_killed() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("pid");
        let hangs = script(
            dir.path(),
            "hangs",
            &format!("echo $$ > '{}'; sleep 600 & wait", pid_file.display()),
        );
        // On a loaded machine the script may not even have written its pid within 400 ms;
        // then it is tried again with a longer wait, so that the group is always checked.
        let mut pid = None;
        for wait in [Duration::from_millis(400), Duration::from_secs(3)] {
            let mut command = Command::new(&hangs);
            command.arg("--version");
            let started = Instant::now();
            let answer = capture(command, wait, 4096, true, false);
            assert!(answer.is_none());
            assert!(started.elapsed() < wait + Duration::from_secs(5));
            pid = fs::read_to_string(&pid_file)
                .ok()
                .and_then(|text| text.trim().parse::<i32>().ok());
            if pid.is_some() {
                break;
            }
        }
        let pid = pid.expect("the script never started within three seconds");
        // The script and the `sleep` it started are gone (its group no longer exists). They
        // were killed; how soon the system has collected them depends on its load.
        let gone_by = Instant::now() + Duration::from_secs(5);
        // SAFETY: signal 0 only asks whether the group exists.
        while unsafe { libc::kill(-pid, 0) } == 0 {
            assert!(Instant::now() < gone_by, "the process group survived");
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn output_is_returned_even_if_something_keeps_the_pipe_open() {
        let dir = tempfile::tempdir().unwrap();
        // A background process inherits the pipe and outlives the script.
        let lingering = script(dir.path(), "lingering", "sleep 600 &\necho 'Python 3.10.2'");
        let started = Instant::now();
        let mut command = Command::new(&lingering);
        command.arg("--version");
        let (ok, out) = capture(command, Duration::from_secs(10), 4096, true, false).unwrap();
        assert!(ok);
        assert_eq!(String::from_utf8_lossy(&out), "Python 3.10.2\n");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn the_shells_environment_is_read_after_the_marker() {
        let out = b"motd noise\nPATH=/wrong\0\n__INFALL_ENV_BEGIN__\nPATH=/a:/b\0HOME=/home/me\0MULTI=line one\nline two\0EMPTY=\0=odd\0noequals\0";
        let vars = parse_env(out).unwrap();
        assert_eq!(env_value(&vars, "PATH"), Some(OsStr::new("/a:/b")));
        assert_eq!(env_value(&vars, "HOME"), Some(OsStr::new("/home/me")));
        assert_eq!(
            env_value(&vars, "MULTI"),
            Some(OsStr::new("line one\nline two"))
        );
        assert_eq!(env_value(&vars, "EMPTY"), Some(OsStr::new("")));
        assert_eq!(vars.len(), 4);
        // No marker, or no PATH after it: not an answer.
        assert!(parse_env(b"PATH=/a\0").is_none());
        assert!(parse_env(b"\n__INFALL_ENV_BEGIN__\nHOME=/h\0").is_none());
        assert!(parse_env(b"").is_none());

        let tidied = tidy(vec![
            ("PATH".into(), "/a".into()),
            ("PWD".into(), "/tmp".into()),
            ("OLDPWD".into(), "/".into()),
            ("SHLVL".into(), "2".into()),
            ("_".into(), "/usr/bin/env".into()),
        ]);
        assert_eq!(tidied, vec![("PATH".into(), "/a".into())]);
    }

    #[test]
    fn a_real_shell_answers_with_a_path() {
        let vars = shell_env(Path::new("/bin/sh"), &["-c"]).expect("/bin/sh gave no environment");
        assert!(env_value(&vars, "PATH").is_some());
        // And the whole lookup always ends with something usable.
        let vars = login_env();
        assert!(env_value(&vars, "PATH").is_some());
        assert!(env_value(&vars, "PWD").is_none());
    }

    #[test]
    fn interpreters_are_looked_up_on_the_shells_path_and_listed_once() {
        let dir = tempfile::tempdir().unwrap();
        let bin_a = dir.path().join("a");
        let bin_b = dir.path().join("b");
        let bin_c = dir.path().join("c");
        for d in [&bin_a, &bin_b, &bin_c] {
            fs::create_dir(d).unwrap();
        }
        // A stand-in interpreter: answers the probe as a program at `real` with `prefix`.
        let fake = |dir: &Path, name: &str, version: &str, real: &Path, prefix: &str| {
            script(
                dir,
                name,
                &format!(
                    "echo 'INFALL {version}'; echo '{0}'; echo '{0}'; echo '{prefix}'",
                    real.display()
                ),
            )
        };
        let real_312 = script(dir.path(), "real312", "true");
        let real_310 = script(dir.path(), "real310", "true");
        // `python3` and `python` in one folder are the same interpreter (a shim each).
        fake(&bin_a, "python3", "3.12.1", &real_312, "/prefix/312");
        fake(&bin_a, "python", "3.12.1", &real_312, "/prefix/312");
        // A second one further down the PATH, and a Python 2 that is not offered.
        fake(&bin_b, "python3", "3.10.9", &real_310, "/prefix/310");
        fake(&bin_b, "python", "2.7.18", &real_310, "/prefix/27");
        // A virtual environment of the first: same program, its own prefix.
        fake(&bin_c, "python", "3.12.1", &real_312, "/venvs/project");
        // Something that is not an interpreter at all, and a non-executable file.
        script(&bin_c, "python3", "echo hello");
        fs::write(dir.path().join("python3"), "").unwrap();

        let path = std::env::join_paths([dir.path(), &bin_a, &bin_b, &bin_c]).unwrap();
        // HOME points nowhere so that only this PATH (and the usual system places) count.
        let env: EnvVars = vec![("PATH".into(), path), ("HOME".into(), dir.path().into())];
        let found = find(&env);
        let ours: Vec<&Interpreter> = found
            .iter()
            .filter(|i| i.path.starts_with(dir.path().to_str().unwrap()))
            .collect();
        let expect = |path: &Path, version: &str| Interpreter {
            path: path.to_str().unwrap().to_owned(),
            version: version.to_owned(),
        };
        assert_eq!(
            ours,
            vec![
                &expect(&real_312, "3.12.1"),
                &expect(&real_310, "3.10.9"),
                &expect(&real_312, "3.12.1"),
            ]
        );
    }
}
