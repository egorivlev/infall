//! Executes approved code: `main.py` in a new owner-only temporary directory, started
//! through the bundled `runner.py` as a process group of its own, its output read from one
//! pipe, its figures and environment collected afterwards, and the directory removed.
//!
//! [`Exec::execute`] takes an [`Approved`] and nothing else: there is no way to hand this
//! module code that did not pass the approval gate.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use base64::Engine;
use qoop_proc::{Group, own_process_group};
use serde::Serialize;

use crate::approvals::{Approved, Cancel};
use crate::monitor::{Bars, Sampler, Usage};
use crate::output::{Kept, Throttle, Utf8Stream};
use crate::python::{self, EnvVars};

/// The program that runs the code and saves its figures. Standard library only.
pub const RUNNER_PY: &str = include_str!("runner.py");

/// A result keeps at most this many figures (api.md §15).
pub const MAX_FIGURES: usize = 3;
/// A figure is at most this many bytes: 160 000 base64 characters.
pub const MAX_FIGURE_BYTES: usize = 120_000;
/// At most this many packages are reported.
pub const MAX_PACKAGES: usize = 8;

/// Usage reports that packages often imported in a Run send by default, turned off for every
/// Run, over whatever the login shell says: each is the package's own documented switch
/// (docs/specs/desktop.md, "How a Run is executed").
pub const NO_USAGE_REPORTS: &[(&str, &str)] = &[
    // qdk, and qsharp from 1.28 on: their READMEs on PyPI, "Telemetry".
    ("QDK_PYTHON_TELEMETRY", "none"),
    // Older qsharp releases: their README on PyPI (1.20.0, "Telemetry").
    ("QSHARP_PYTHON_TELEMETRY", "none"),
    // huggingface_hub, for transformers, datasets, diffusers and the rest: its documentation,
    // "Environment variables".
    ("HF_HUB_DISABLE_TELEMETRY", "1"),
    // mlflow 3.2 and later: its documentation, "Usage Tracking".
    ("MLFLOW_DISABLE_TELEMETRY", "true"),
];

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
const ENV_FILE: &str = "qoop-env.json";

/// One saved figure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Figure {
    /// The PNG file, base64.
    pub png: String,
}

/// Where the code was executed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Env {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub python: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub packages: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arch: Option<String>,
}

/// What happens while the code is executed.
#[derive(Debug, Clone, PartialEq)]
pub enum Progress {
    /// The process is running.
    Started,
    /// More output.
    Output(String),
    /// What the process is using now, and how far the code says it is. Never after the
    /// process has ended.
    Stats(Usage),
}

/// How the execution ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finished {
    /// The exit code; `None` when the process was stopped or killed.
    pub exit: Option<i32>,
    /// The Member (or the app closing) stopped it.
    pub stopped: bool,
    pub duration_ms: u64,
    pub output: String,
    pub output_truncated: bool,
    pub figures: Vec<Figure>,
    pub env: Env,
}

/// How to execute: chosen by the Member in the app's settings, never by a page.
#[derive(Debug, Clone)]
pub struct Exec {
    /// The interpreter.
    pub python: PathBuf,
    /// Its version as the settings know it; reported when the program itself could not say.
    pub python_version: Option<String>,
    /// The folder to run in; `None` for the Run's own temporary directory.
    pub folder: Option<PathBuf>,
    /// The environment of the process (the login shell's).
    pub env: EnvVars,
    /// Where the temporary directory is made.
    pub temp_root: PathBuf,
    /// How long the process gets to stop after a polite request, before it is killed.
    pub kill_grace: Duration,
}

/// The Run's temporary directory: only the owner can enter it; removed when dropped.
struct RunDir {
    path: PathBuf,
}

impl RunDir {
    fn create(root: &Path) -> io::Result<Self> {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        for _ in 0..16 {
            let nanos = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0);
            let path = root.join(format!(
                "qoop-run-{}-{}-{}",
                std::process::id(),
                nanos,
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            #[cfg_attr(not(unix), allow(unused_mut))]
            let mut builder = fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            // Not recursive: fails if anything is already there, so nothing prepared by
            // someone else is ever used.
            match builder.create(&path) {
                Ok(()) => {
                    // Symlinks in the path (macOS: /var → /private/var) resolved, so the
                    // program sees the same path the app uses. Not on Windows, where the
                    // resolved form is a `\\?\` path that not every program accepts.
                    #[cfg(unix)]
                    let path = path.canonicalize().unwrap_or(path);
                    return Ok(Self { path });
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        Err(io::Error::other("no free name for a temporary directory"))
    }

    /// Writes a new file only the owner can read.
    fn write(&self, name: &str, contents: &[u8]) -> io::Result<PathBuf> {
        let path = self.path.join(name);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path)?;
        file.write_all(contents)?;
        file.sync_all()?;
        Ok(path)
    }
}

impl Drop for RunDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// Reads a regular file of at most `limit` bytes; never follows a link (the program could
/// have put one there).
pub(crate) fn read_small_file(path: &Path, limit: usize) -> Option<Vec<u8>> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT: opens a link itself, which is then not a regular file.
        options.custom_flags(0x0020_0000);
    }
    let file = options.open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > limit as u64 {
        return None;
    }
    let mut data = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut data).ok()?;
    (data.len() <= limit).then_some(data)
}

fn short_plain(text: &str, max_chars: usize) -> bool {
    !text.is_empty() && text.chars().count() <= max_chars && !text.chars().any(char::is_control)
}

/// What `runner.py` left behind: the Python version, the packages, and the figures. All of
/// it is checked as if a stranger had written it; the program could have.
fn collect(
    dir: &Path,
) -> (
    Option<String>,
    Option<BTreeMap<String, String>>,
    Vec<Figure>,
) {
    let Some(info) = read_small_file(&dir.join(ENV_FILE), 64 * 1024)
        .and_then(|data| serde_json::from_slice::<serde_json::Value>(&data).ok())
    else {
        return (None, None, Vec::new());
    };
    let python = info["python"]
        .as_str()
        .filter(|v| {
            v.len() <= 40
                && v.starts_with(|c: char| c.is_ascii_digit())
                && v.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
        })
        .map(str::to_owned);
    let mut packages = BTreeMap::new();
    if let Some(reported) = info["packages"].as_array() {
        for entry in reported {
            if packages.len() == MAX_PACKAGES {
                break;
            }
            if let (Some(name), Some(version)) = (entry[0].as_str(), entry[1].as_str())
                && short_plain(name, 60)
                && short_plain(version, 40)
            {
                packages.insert(name.to_owned(), version.to_owned());
            }
        }
    }
    let mut figures = Vec::new();
    if let Some(names) = info["figures"].as_array() {
        for name in names.iter().filter_map(|n| n.as_str()) {
            if figures.len() == MAX_FIGURES {
                break;
            }
            // Only the names runner.py uses; never a path.
            let known = (1..=MAX_FIGURES).any(|n| name == format!("qoop-figure-{n}.png"));
            if !known {
                continue;
            }
            if let Some(data) = read_small_file(&dir.join(name), MAX_FIGURE_BYTES)
                && data.starts_with(PNG_SIGNATURE)
            {
                figures.push(Figure {
                    png: base64::engine::general_purpose::STANDARD.encode(data),
                });
            }
        }
    }
    (python, (!packages.is_empty()).then_some(packages), figures)
}

fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        other => other,
    }
}

impl Exec {
    /// Executes the approved code to its end, calling `on_progress` on this thread. Blocks
    /// until the process group is gone and the temporary directory is removed. The error is a
    /// plain sentence: nothing was executed.
    pub fn execute(
        &self,
        approved: &Approved,
        cancel: &Cancel,
        on_progress: &mut dyn FnMut(Progress),
    ) -> Result<Finished, String> {
        const NO_FOLDER: &str = "Infall could not prepare a temporary folder for the Run.";
        // Dropped last, at every exit: the directory goes after the process group.
        let dir = RunDir::create(&self.temp_root).map_err(|_| NO_FOLDER)?;
        let main_py = dir
            .write("main.py", approved.code().as_bytes())
            .map_err(|_| NO_FOLDER)?;
        let runner_py = dir
            .write("runner.py", RUNNER_PY.as_bytes())
            .map_err(|_| NO_FOLDER)?;
        let cwd = self.folder.as_deref().unwrap_or(&dir.path);

        // One pipe for standard output and standard error, so their order is kept.
        let (mut reader, writer) = io::pipe().map_err(|_| NO_FOLDER)?;
        let mut command = Command::new(&self.python);
        command
            // The code is handed over as a file: never on the command line.
            .args(["-u", "-X", "utf8"])
            .arg(&runner_py)
            .arg(&main_py)
            .current_dir(cwd)
            .env_clear()
            .envs(self.env.iter().map(|(k, v)| (k, v)))
            .envs(NO_USAGE_REPORTS.iter().copied())
            .env("MPLBACKEND", "Agg")
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .env("QOOP_RUN_DIR", &dir.path)
            .stdin(Stdio::null())
            .stdout(writer.try_clone().map_err(|_| NO_FOLDER)?)
            .stderr(writer);
        own_process_group(&mut command);
        let started = Instant::now();
        let child = command
            .spawn()
            .map_err(|_| "Python could not be started. Check Runner settings.")?;
        // The command holds the writing ends of the pipe; without this the reader never ends.
        drop(command);
        let mut group = Group::new(child);
        on_progress(Progress::Started);
        // Measures on a thread of its own: nothing below ever waits for it.
        let sampler = Sampler::start(
            group.id(),
            dir.path.clone(),
            python::env_value(&self.env, "PATH"),
            started,
        );

        // Bounded: a program that prints faster than it can be read waits, as with any pipe.
        let (tx, rx) = mpsc::sync_channel::<Option<Vec<u8>>>(16);
        thread::spawn(move || {
            let mut buffer = vec![0u8; 32 * 1024];
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

        let mut decoder = Utf8Stream::default();
        let mut kept = Kept::default();
        let mut throttle = Throttle::new();
        let mut bars = Bars::default();
        let mut text = String::new();
        let mut eof = false;
        let mut stopped = false;
        // Set once the process has ended: its status, when, and how long to keep reading.
        let mut ended: Option<(Option<std::process::ExitStatus>, Duration, Instant)> = None;
        loop {
            if eof {
                thread::sleep(Duration::from_millis(15));
            } else {
                match rx.recv_timeout(Duration::from_millis(25)) {
                    Ok(Some(bytes)) => {
                        text.clear();
                        decoder.push(&bytes, &mut text);
                        kept.push(&text);
                        throttle.push(&text);
                        bars.push(&text);
                    }
                    Ok(None) | Err(RecvTimeoutError::Disconnected) => eof = true,
                    Err(RecvTimeoutError::Timeout) => {}
                }
            }
            let now = Instant::now();
            if let Some(event) = throttle.due(now) {
                on_progress(Progress::Output(event));
            }
            if ended.is_none()
                && let Some(mut usage) = sampler.latest()
            {
                // Nothing said through `qoop`: a progress bar in the output says it.
                if usage.step.is_none()
                    && usage.progress.is_none()
                    && let Some(bar) = bars.last()
                {
                    usage.step = bar.step;
                    usage.progress = bar.progress;
                }
                on_progress(Progress::Stats(usage));
            }
            match &ended {
                None => {
                    if cancel.is_cancelled() {
                        // The whole group: the program and everything it started.
                        let status = group.terminate(self.kill_grace);
                        stopped = true;
                        ended = Some((status, started.elapsed(), now + Duration::from_millis(300)));
                    } else if group.exited() {
                        let duration = started.elapsed();
                        // Whatever it left running in its group goes with it.
                        let status = group.kill_and_reap();
                        ended = Some((status, duration, now + Duration::from_secs(2)));
                    }
                }
                Some(_) if eof => break,
                // Something that left the group still holds the pipe: stop reading.
                Some((_, _, read_until)) if now > *read_until => break,
                Some(_) => {}
            }
            if ended.is_some() {
                sampler.stop();
            }
        }
        let (status, duration, _) = ended.expect("the loop only ends after the process");

        text.clear();
        decoder.finish(&mut text);
        let exit = if stopped {
            None
        } else {
            status.and_then(|s| s.code())
        };
        #[cfg(unix)]
        if !stopped
            && exit.is_none()
            && let Some(signal) = status.and_then(|s| {
                use std::os::unix::process::ExitStatusExt;
                s.signal()
            })
        {
            text.push_str(&format!(
                "\n[qoop] The process was ended by signal {signal}.\n"
            ));
        }
        if !text.is_empty() {
            kept.push(&text);
            throttle.push(&text);
        }
        if let Some(event) = throttle.take() {
            on_progress(Progress::Output(event));
        }

        let (python, packages, figures) = if stopped {
            (None, None, Vec::new())
        } else {
            collect(&dir.path)
        };
        let (output, output_truncated) = kept.finish();
        Ok(Finished {
            exit,
            stopped,
            duration_ms: duration.as_millis() as u64,
            output,
            output_truncated,
            figures,
            env: Env {
                python: python.or_else(|| self.python_version.clone()),
                packages,
                os: Some(std::env::consts::OS.to_owned()),
                arch: Some(arch().to_owned()),
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(extra: usize) -> Vec<u8> {
        let mut data = PNG_SIGNATURE.to_vec();
        data.resize(PNG_SIGNATURE.len() + extra, 7);
        data
    }

    #[test]
    fn what_the_program_left_behind_is_checked() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        assert_eq!(collect(d), (None, None, Vec::new()));

        fs::write(d.join("qoop-figure-1.png"), png(100)).unwrap();
        fs::write(d.join("qoop-figure-2.png"), b"GIF89a not a png").unwrap();
        fs::write(d.join("qoop-figure-3.png"), png(MAX_FIGURE_BYTES)).unwrap(); // 8 too many
        fs::write(d.join("other.png"), png(10)).unwrap();
        fs::write(
            d.join(ENV_FILE),
            serde_json::json!({
                "python": "3.12.3",
                "packages": [
                    ["numpy", "1.26.4"], ["bad\nname", "1"], ["x", ""], ["y", "v".repeat(41)],
                    ["n".repeat(61), "1"], [1, 2], "junk", ["ok", "2.0+cu121"]
                ],
                "figures": [
                    "qoop-figure-1.png", "qoop-figure-2.png", "qoop-figure-3.png", "other.png",
                    "../qoop-figure-1.png", "/etc/passwd", "qoop-figure-4.png", 5
                ],
            })
            .to_string(),
        )
        .unwrap();
        let (python, packages, figures) = collect(d);
        assert_eq!(python.as_deref(), Some("3.12.3"));
        let packages = packages.unwrap();
        assert_eq!(
            packages.into_iter().collect::<Vec<_>>(),
            vec![
                ("numpy".to_owned(), "1.26.4".to_owned()),
                ("ok".to_owned(), "2.0+cu121".to_owned())
            ]
        );
        // Only the real, small enough PNG with a known name.
        assert_eq!(figures.len(), 1);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&figures[0].png)
            .unwrap();
        assert_eq!(bytes, png(100));

        // Exactly the limit is kept, and is exactly 160 000 base64 characters.
        fs::write(d.join("qoop-figure-3.png"), png(MAX_FIGURE_BYTES - 8)).unwrap();
        let (_, _, figures) = collect(d);
        assert_eq!(figures.len(), 2);
        assert_eq!(figures[1].png.len(), 160_000);
    }

    #[test]
    fn at_most_eight_packages_and_three_figures() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        for n in 1..=3 {
            fs::write(d.join(format!("qoop-figure-{n}.png")), png(n)).unwrap();
        }
        let packages: Vec<_> = (0..20)
            .map(|n| vec![format!("p{n:02}"), "1".into()])
            .collect();
        fs::write(
            d.join(ENV_FILE),
            serde_json::json!({
                "python": "3.9.6; rm -rf",
                "packages": packages,
                "figures": ["qoop-figure-1.png", "qoop-figure-1.png", "qoop-figure-2.png", "qoop-figure-3.png"],
            })
            .to_string(),
        )
        .unwrap();
        let (python, packages, figures) = collect(d);
        assert_eq!(python, None);
        assert_eq!(packages.unwrap().len(), MAX_PACKAGES);
        assert_eq!(figures.len(), MAX_FIGURES);
    }

    #[cfg(unix)]
    #[test]
    fn links_and_oversized_files_are_not_read() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.png");
        fs::write(&secret, png(50)).unwrap();
        std::os::unix::fs::symlink(&secret, d.join("qoop-figure-1.png")).unwrap();
        fs::write(d.join(ENV_FILE), r#"{"figures":["qoop-figure-1.png"]}"#).unwrap();
        assert_eq!(collect(d).2, Vec::new());
        assert!(read_small_file(&secret, 1000).is_some());
        assert!(read_small_file(&d.join("qoop-figure-1.png"), 1000).is_none());
        assert!(read_small_file(d, 1000).is_none());

        // The description itself as a link, or too large, or not JSON: nothing is reported.
        fs::remove_file(d.join(ENV_FILE)).unwrap();
        let real = outside.path().join("env.json");
        fs::write(&real, r#"{"python":"3.12.0"}"#).unwrap();
        std::os::unix::fs::symlink(&real, d.join(ENV_FILE)).unwrap();
        assert_eq!(collect(d), (None, None, Vec::new()));
        fs::remove_file(d.join(ENV_FILE)).unwrap();
        fs::write(
            d.join(ENV_FILE),
            format!("{{\"python\":\"3.1\",\"x\":\"{}\"}}", "a".repeat(70_000)),
        )
        .unwrap();
        assert_eq!(collect(d), (None, None, Vec::new()));
        fs::write(d.join(ENV_FILE), "[1,2").unwrap();
        assert_eq!(collect(d), (None, None, Vec::new()));
        fs::write(d.join(ENV_FILE), "[1,2]").unwrap();
        assert_eq!(collect(d), (None, None, Vec::new()));
    }

    #[cfg(unix)]
    #[test]
    fn the_temporary_directory_is_private_and_removed() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let dir = RunDir::create(root.path()).unwrap();
        let path = dir.path.clone();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let file = dir.write("main.py", b"print(1)").unwrap();
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        // A second file of the same name is refused rather than written through.
        assert!(dir.write("main.py", b"other").is_err());
        assert_eq!(fs::read(&file).unwrap(), b"print(1)");
        // Two directories never share a path.
        let other = RunDir::create(root.path()).unwrap();
        assert_ne!(other.path, path);
        drop(dir);
        assert!(!path.exists());
        assert!(other.path.exists());
    }
}
