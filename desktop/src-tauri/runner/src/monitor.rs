//! The Runner monitor (docs/specs/desktop.md, "M9 — the Runner monitor"): what a Run is
//! doing to the Member's computer while it executes, and how far the code says it is.
//!
//! Measured about once a second on a thread of its own, with the system's own tools (`ps`,
//! `sysctl`, `ioreg`, `nvidia-smi`) started by their full paths with a short timeout, so that
//! nothing here can delay the Run's output or its cancel. A sample that cannot be taken is
//! skipped. What the code says through `infall` arrives in a file the Run's own program
//! wrote, and what a progress bar shows arrives in its output: both are checked as if a
//! stranger had written them.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::exec::read_small_file;

/// The file `infall.step` and `infall.progress` write in the Run's temporary directory.
pub const SAID_FILE: &str = "infall-progress.json";
/// Its name before the rename, which code in another language saved before it may still
/// write: read when the new one is not there (docs/specs/desktop.md, "Names before the
/// rename").
pub const OLD_SAID_FILE: &str = "qoop-progress.json";
/// A step is at most this long. Counted in UTF-16 units, as the kept output is.
pub const MAX_STEP: usize = 120;

/// The first sample is taken this long after the process started, the others one
/// [`INTERVAL`] apart.
const FIRST_SAMPLE: Duration = Duration::from_millis(800);
const INTERVAL: Duration = Duration::from_secs(1);
/// How long one of the system's tools gets to answer.
const COMMAND_TIMEOUT: Duration = Duration::from_millis(800);
/// The most that is read of a tool's answer.
const MAX_ANSWER: u64 = 1024 * 1024;
/// A progress bar is one line of at most this many bytes.
const MAX_BAR_LINE: usize = 600;

/// The whole computer's graphics processor.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Gpu {
    pub percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// How far the code is: `total > 0`, `0 ≤ done ≤ total`, both finite.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct HowFar {
    pub done: f64,
    pub total: f64,
}

/// One sample (desktop.md: `RunUsage`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Usage {
    /// Of the Run's whole process group; 100 = one core fully busy.
    pub cpu_percent: f64,
    /// Logical cores of this computer.
    pub cores: u32,
    /// Resident memory of the Run's process group.
    pub memory_bytes: u64,
    pub memory_total_bytes: u64,
    /// Processes in the Run's group.
    pub processes: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu: Option<Gpu>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<HowFar>,
}

/// What the code says it is doing: through `infall`, or with a progress bar.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Said {
    pub step: Option<String>,
    pub progress: Option<HowFar>,
}

impl Said {
    pub fn is_empty(&self) -> bool {
        self.step.is_none() && self.progress.is_none()
    }
}

// ---- what the code says ----------------------------------------------------------------------

/// A step as it may be shown: its first line that says anything, without control
/// characters, at most [`MAX_STEP`] long. `None` when nothing is left.
pub fn clean_step(text: &str) -> Option<String> {
    let mut step = String::new();
    let mut units = 0;
    for line in text.split(['\n', '\r']) {
        for c in line.trim().chars().filter(|c| !c.is_control()) {
            if units + c.len_utf16() > MAX_STEP {
                break;
            }
            units += c.len_utf16();
            step.push(c);
        }
        if !step.trim().is_empty() {
            break;
        }
        step.clear();
        units = 0;
    }
    let step = step.trim();
    (!step.is_empty()).then(|| step.to_owned())
}

/// `done` of `total`, if that is a position at all; `done` is brought into `0..=total`.
pub fn how_far(done: f64, total: f64) -> Option<HowFar> {
    (done.is_finite() && total.is_finite() && total > 0.0).then(|| HowFar {
        done: done.clamp(0.0, total),
        total,
    })
}

/// What [`SAID_FILE`] says: `{"step": "…", "done": 3, "total": 10}`, every key optional.
/// Anything else in it is ignored.
pub fn parse_said(data: &[u8]) -> Said {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(data) else {
        return Said::default();
    };
    Said {
        step: value["step"].as_str().and_then(clean_step),
        progress: match (value["done"].as_f64(), value["total"].as_f64()) {
            (Some(done), Some(total)) => how_far(done, total),
            _ => None,
        },
    }
}

/// A count as tqdm prints it: `45`, `1.5`, or scaled, `1.20k`, `3.4M`.
fn bar_count(text: &str) -> Option<f64> {
    let (number, scale) = match text.char_indices().last()? {
        (at, 'k' | 'K') => (&text[..at], 1e3),
        (at, 'M') => (&text[..at], 1e6),
        (at, 'G') => (&text[..at], 1e9),
        (at, 'T') => (&text[..at], 1e12),
        _ => (text, 1.0),
    };
    let plain = !number.is_empty() && number.chars().all(|c| c.is_ascii_digit() || c == '.');
    let value = number.parse::<f64>().ok().filter(|_| plain)?;
    Some(value * scale)
}

/// Reads one line as a tqdm-style progress bar:
/// `desc:  45%|████▌     | 45/100 [00:10<00:12,  4.31it/s]`. The description, if there is
/// one, is the step. A bar without a total (`45it [00:10, …]`) says nothing about how far.
pub fn parse_bar(line: &str) -> Option<Said> {
    let (before, rest) = line.split_once("%|")?;
    // The percentage itself is not used: the counts say the same, more exactly.
    let left = before.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.');
    if left.len() == before.len() {
        return None;
    }
    let (_bar, right) = rest.split_once("| ")?;
    let (counts, _) = right.split_once(" [")?;
    let (done, total) = counts.trim().split_once('/')?;
    let progress = how_far(bar_count(done)?, bar_count(total)?)?;
    let description = left.trim();
    Some(Said {
        step: clean_step(description.strip_suffix(':').unwrap_or(description)),
        progress: Some(progress),
    })
}

/// Finds the last progress bar in a Run's output as it streams by. A bar is redrawn in
/// place with `\r`, so a line ends at `\r` as well as at `\n`, and the bar on screen is
/// usually the line that has not ended yet.
#[derive(Default)]
pub struct Bars {
    /// The line that has not ended yet.
    pending: String,
    /// That line is longer than any bar: whatever it is, it is not looked at.
    too_long: bool,
    last: Option<Said>,
}

impl Bars {
    pub fn push(&mut self, text: &str) {
        for (n, piece) in text.split(['\r', '\n']).enumerate() {
            if n > 0 {
                // A line ended.
                if let Some(bar) = self.pending_bar() {
                    self.last = Some(bar);
                }
                self.pending.clear();
                self.too_long = false;
            }
            if self.too_long || self.pending.len() + piece.len() > MAX_BAR_LINE {
                self.too_long = true;
                self.pending.clear();
            } else {
                self.pending.push_str(piece);
            }
        }
    }

    fn pending_bar(&self) -> Option<Said> {
        if self.too_long {
            return None;
        }
        parse_bar(&self.pending)
    }

    /// The last bar the output showed, if it showed any.
    pub fn last(&self) -> Option<Said> {
        self.pending_bar().or_else(|| self.last.clone())
    }
}

// ---- what the system's tools answer ----------------------------------------------------------

/// One process of the Run's group, as `ps` describes it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Process {
    pub pid: u32,
    pub memory_bytes: u64,
    /// Processor time used since it started.
    pub cpu_seconds: f64,
}

/// The arguments for `ps` that [`parse_ps`] reads. One `-o` each: BSD `ps` takes everything
/// after `=` as the column's heading.
pub const PS_ARGS: [&str; 11] = [
    "-A", "-o", "pid=", "-o", "pgid=", "-o", "rss=", "-o", "time=", "-o", "stat=",
];

/// Processor time as `ps` prints it: `0:01.23` and `327:16.68` (macOS: minutes, seconds),
/// `00:00:07` and `1-02:03:04` (Linux: days, hours, minutes, seconds).
fn cpu_time(text: &str) -> Option<f64> {
    let (days, clock) = match text.split_once('-') {
        Some((days, clock)) => (days.parse::<u32>().ok()?, clock),
        None => (0, text),
    };
    let mut seconds = 0.0;
    let mut parts = 0;
    for part in clock.split(':') {
        let plain = !part.is_empty() && part.chars().all(|c| c.is_ascii_digit() || c == '.');
        seconds = seconds * 60.0 + part.parse::<f64>().ok().filter(|_| plain)?;
        parts += 1;
    }
    (2..=3)
        .contains(&parts)
        .then_some(f64::from(days) * 86_400.0 + seconds)
}

/// The processes of group `pgid` in the answer of `ps` [`PS_ARGS`]. Processes that have
/// ended and only wait to be collected are left out; lines that are not understood too.
pub fn parse_ps(text: &str, pgid: u32) -> Vec<Process> {
    let mut processes = Vec::new();
    for line in text.lines() {
        let mut fields = line.split_whitespace();
        let (Some(pid), Some(group), Some(rss), Some(time), Some(state)) = (
            fields.next().and_then(|f| f.parse::<u32>().ok()),
            fields.next().and_then(|f| f.parse::<u32>().ok()),
            fields.next().and_then(|f| f.parse::<u64>().ok()),
            fields.next().and_then(cpu_time),
            fields.next(),
        ) else {
            continue;
        };
        if group == pgid && !state.starts_with('Z') {
            processes.push(Process {
                pid,
                // `rss` is in units of 1024 bytes on macOS and on Linux.
                memory_bytes: rss.saturating_mul(1024),
                cpu_seconds: time,
            });
        }
    }
    processes
}

/// The arguments for `ps` that [`parse_escaped`] reads.
pub const FAMILY_PS_ARGS: [&str; 7] = ["-A", "-o", "pid=", "-o", "ppid=", "-o", "pgid="];

/// A process the Run started (it, or one of its descendants) that has left the Run's
/// process group for another: as Julia's `Distributed` starts its workers (`detach`), or
/// a shell with job control its background jobs. Stopping the group does not reach it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Escaped {
    pub pid: u32,
    pub pgid: u32,
}

/// `pid ppid pgid` lines of `ps` [`FAMILY_PS_ARGS`]; lines not understood are passed over.
fn family_rows(text: &str) -> Vec<(u32, u32, u32)> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace().map(|f| f.parse::<u32>().ok());
            match (fields.next(), fields.next(), fields.next(), fields.next()) {
                (Some(Some(pid)), Some(Some(ppid)), Some(Some(pgid)), None) => {
                    Some((pid, ppid, pgid))
                }
                _ => None,
            }
        })
        .collect()
}

/// The descendants of `leader` (which leads the Run's group) that are in another group, in
/// the answer of `ps` [`FAMILY_PS_ARGS`]. One whose parent has already ended is not found:
/// it is asked while the Run's process is still there.
pub fn parse_escaped(text: &str, leader: u32) -> Vec<Escaped> {
    let rows = family_rows(text);
    let mut family = vec![leader];
    let mut escaped = Vec::new();
    let mut next = 0;
    while next < family.len() {
        let parent = family[next];
        next += 1;
        for &(pid, ppid, pgid) in &rows {
            if ppid == parent && pid > 1 && !family.contains(&pid) {
                family.push(pid);
                if pgid != leader {
                    escaped.push(Escaped { pid, pgid });
                }
            }
        }
    }
    escaped
}

/// The processes of the Run led by `leader` that left its group, asked of `ps` now (in
/// well under a second). Empty when `ps` does not answer.
#[cfg(unix)]
pub(crate) fn escaped_from(leader: u32) -> Vec<Escaped> {
    first_file(&["/bin/ps", "/usr/bin/ps"])
        .and_then(|ps| answer_of(&ps, &FAMILY_PS_ARGS))
        .map(|text| parse_escaped(&text, leader))
        .unwrap_or_default()
}

/// Of `escaped`, those still there as they were (the same id in the same group, so not an
/// id given to another process since): what [`kill_escaped`] kills. One that leads its own
/// group is killed with that group, which holds only what it started.
pub fn still_escaped(text: &str, escaped: &[Escaped]) -> Vec<i32> {
    let rows = family_rows(text);
    escaped
        .iter()
        .filter(|e| {
            rows.iter()
                .any(|&(pid, _, pgid)| (pid, pgid) == (e.pid, e.pgid))
        })
        .filter_map(|e| {
            let pid = i32::try_from(e.pid).ok().filter(|p| *p > 1)?;
            Some(if e.pid == e.pgid { -pid } else { pid })
        })
        .collect()
}

/// Kills what is left of `escaped`, once the Run's own group is gone.
#[cfg(unix)]
pub(crate) fn kill_escaped(escaped: &[Escaped]) {
    if escaped.is_empty() {
        return;
    }
    let Some(text) =
        first_file(&["/bin/ps", "/usr/bin/ps"]).and_then(|ps| answer_of(&ps, &FAMILY_PS_ARGS))
    else {
        return;
    };
    for target in still_escaped(&text, escaped) {
        // SAFETY: `kill` touches no memory. Each target was checked a moment ago to be the
        // same process (or group) the Run started; an error (it is gone) is fine to ignore.
        unsafe {
            libc::kill(target, libc::SIGKILL);
        }
    }
}

/// Processor time in clock ticks (user and system) from Linux's `/proc/<pid>/stat`, where
/// `ps` only counts whole seconds. The program's name, in brackets, may contain anything.
pub fn parse_proc_stat(text: &str) -> Option<u64> {
    let after_name = &text[text.rfind(')')? + 1..];
    // After the name: state, then fields 4 to 13, then utime (14) and stime (15).
    let mut fields = after_name.split_whitespace().skip(11);
    let user = fields.next()?.parse::<u64>().ok()?;
    let system = fields.next()?.parse::<u64>().ok()?;
    Some(user.saturating_add(system))
}

/// The answer of `sysctl -n hw.memsize` (macOS): bytes.
pub fn parse_memsize(text: &str) -> Option<u64> {
    text.trim().parse::<u64>().ok().filter(|bytes| *bytes > 0)
}

/// `MemTotal` of Linux's `/proc/meminfo`, in bytes.
pub fn parse_meminfo(text: &str) -> Option<u64> {
    let line = text.lines().find_map(|l| l.strip_prefix("MemTotal:"))?;
    let kilobytes = line.trim().strip_suffix("kB")?.trim().parse::<u64>().ok()?;
    (kilobytes > 0).then(|| kilobytes.saturating_mul(1024))
}

fn gpu(percent: f64, name: Option<&str>) -> Option<Gpu> {
    let name = name
        .map(str::trim)
        .filter(|n| !n.is_empty() && n.chars().count() <= 80 && !n.chars().any(char::is_control));
    percent.is_finite().then(|| Gpu {
        percent: percent.clamp(0.0, 100.0),
        name: name.map(str::to_owned),
    })
}

/// The answer of `ioreg -r -d 1 -c IOAccelerator` (macOS): "Device Utilization %" of the
/// busiest graphics processor, and its "model".
pub fn parse_ioreg(text: &str) -> Option<Gpu> {
    let mut best: Option<Gpu> = None;
    // One entry per graphics processor, each starting with `+-o`.
    for entry in text.split("+-o ").skip(1) {
        let Some(percent) = entry
            .split_once("\"Device Utilization %\"=")
            .and_then(|(_, rest)| {
                let digits = rest
                    .find(|c: char| !c.is_ascii_digit())
                    .unwrap_or(rest.len());
                rest[..digits].parse::<u32>().ok()
            })
        else {
            continue;
        };
        // `"model" = "Apple M4"`, or on older computers `"model" = <"AMD Radeon Pro 5500M">`.
        let name = entry
            .lines()
            .find_map(|l| l.trim_start().strip_prefix("\"model\" = "))
            .and_then(|value| {
                let start = value.find('"')? + 1;
                let end = value.rfind('"')?;
                (start < end).then(|| &value[start..end])
            });
        if best.as_ref().is_none_or(|b| f64::from(percent) > b.percent) {
            best = gpu(f64::from(percent), name).or(best);
        }
    }
    best
}

/// The answer of `nvidia-smi --query-gpu=utilization.gpu,name --format=csv,noheader,nounits`
/// (Linux): one line per graphics processor, `45, NVIDIA GeForce RTX 3090`. The busiest.
pub fn parse_nvidia_smi(text: &str) -> Option<Gpu> {
    let mut best: Option<Gpu> = None;
    for line in text.lines() {
        let (percent, name) = match line.split_once(',') {
            Some((percent, name)) => (percent, Some(name)),
            None => (line, None),
        };
        let Ok(percent) = percent.trim().parse::<u32>() else {
            continue;
        };
        if best.as_ref().is_none_or(|b| f64::from(percent) > b.percent) {
            best = gpu(f64::from(percent), name).or(best);
        }
    }
    best
}

/// How busy the processor was between two samples, from how much processor time each
/// process had used at either.
#[derive(Default)]
pub struct CpuMeter {
    /// Processor time of each process at the last sample.
    seen: HashMap<u32, f64>,
}

impl CpuMeter {
    /// `processes`: pid and processor time used so far; `elapsed`: seconds since the last
    /// call (the first time: since the Run started, when none of them had used any).
    /// 100 = one core fully busy.
    pub fn percent(&mut self, processes: &[(u32, f64)], elapsed: f64) -> f64 {
        let mut busy = 0.0;
        let mut seen = HashMap::with_capacity(processes.len());
        for (pid, seconds) in processes {
            // A process not seen before started after the last sample: all of its time
            // falls in between.
            busy += (seconds - self.seen.get(pid).copied().unwrap_or(0.0)).max(0.0);
            seen.insert(*pid, *seconds);
        }
        self.seen = seen;
        if elapsed <= 0.0 || !busy.is_finite() {
            return 0.0;
        }
        (1000.0 * busy / elapsed).round() / 10.0
    }
}

// ---- asking the system -----------------------------------------------------------------------

/// Starts one of the system's tools and returns what it printed, if it answered in time
/// and said it succeeded. The tool gets no input and an empty environment, and never
/// outlives the call.
fn answer_of(program: &Path, args: &[&str]) -> Option<String> {
    let mut child = Command::new(program)
        .args(args)
        .env_clear()
        // Numbers with a point, whatever the Member's language.
        .env("LC_ALL", "C")
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + COMMAND_TIMEOUT;
    let stdout = child.stdout.take();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut data = Vec::new();
        let read = stdout.and_then(|out| out.take(MAX_ANSWER).read_to_end(&mut data).ok());
        let _ = tx.send(read.map(|_| data));
    });
    let data = rx.recv_timeout(COMMAND_TIMEOUT).ok().flatten();
    let succeeded = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    data.filter(|_| succeeded)
        .map(|data| String::from_utf8_lossy(&data).into_owned())
}

fn first_file(candidates: &[&str]) -> Option<PathBuf> {
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|p| infall_proc::is_executable_file(p))
}

/// `nvidia-smi` in one of the directories of `path` (full paths only: never a program in
/// whatever folder the Run happens to execute in).
fn on_path(name: &str, path: Option<&OsStr>) -> Option<PathBuf> {
    std::env::split_paths(path?)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|p| infall_proc::is_executable_file(p))
}

fn clock_ticks_per_second() -> f64 {
    #[cfg(unix)]
    {
        // SAFETY: `sysconf` only reads a constant of the system.
        let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        if ticks > 0 {
            return ticks as f64;
        }
    }
    100.0
}

/// How often a reading that keeps failing is tried before it is given up for this Run.
const TRIES: u8 = 3;

/// Takes the samples of one Run.
struct Machine {
    pgid: u32,
    run_dir: PathBuf,
    ps: Option<PathBuf>,
    sysctl: Option<PathBuf>,
    ioreg: Option<PathBuf>,
    nvidia_smi: Option<PathBuf>,
    /// Linux: processor time is read from `/proc`.
    proc_stat: bool,
    ticks: f64,
    cores: u32,
    /// Read once.
    memory_total: Option<u64>,
    memory_total_tries: u8,
    gpu_failures: u8,
    meter: CpuMeter,
    last: Instant,
}

impl Machine {
    fn new(pgid: u32, run_dir: PathBuf, path: Option<&OsStr>, started: Instant) -> Self {
        let ioreg = first_file(&["/usr/sbin/ioreg"]);
        Self {
            pgid,
            run_dir,
            ps: first_file(&["/bin/ps", "/usr/bin/ps"]),
            sysctl: first_file(&["/usr/sbin/sysctl"]),
            nvidia_smi: match ioreg {
                Some(_) => None,
                None => on_path("nvidia-smi", path),
            },
            ioreg,
            proc_stat: Path::new("/proc/self/stat").is_file(),
            ticks: clock_ticks_per_second(),
            cores: thread::available_parallelism().map_or(1, |n| n.get() as u32),
            memory_total: None,
            memory_total_tries: 0,
            gpu_failures: 0,
            meter: CpuMeter::default(),
            last: started,
        }
    }

    fn memory_total(&mut self) -> Option<u64> {
        if self.memory_total.is_none() && self.memory_total_tries < TRIES {
            self.memory_total_tries += 1;
            self.memory_total = std::fs::read_to_string("/proc/meminfo")
                .ok()
                .and_then(|text| parse_meminfo(&text))
                .or_else(|| {
                    let text = answer_of(self.sysctl.as_deref()?, &["-n", "hw.memsize"])?;
                    parse_memsize(&text)
                });
        }
        self.memory_total
    }

    fn gpu(&mut self) -> Option<Gpu> {
        if self.gpu_failures >= TRIES {
            return None;
        }
        let gpu = if let Some(ioreg) = &self.ioreg {
            answer_of(ioreg, &["-r", "-d", "1", "-c", "IOAccelerator"])
                .and_then(|text| parse_ioreg(&text))
        } else if let Some(nvidia_smi) = &self.nvidia_smi {
            answer_of(
                nvidia_smi,
                &[
                    "--query-gpu=utilization.gpu,name",
                    "--format=csv,noheader,nounits",
                ],
            )
            .and_then(|text| parse_nvidia_smi(&text))
        } else {
            self.gpu_failures = TRIES;
            None
        };
        match gpu {
            Some(_) => self.gpu_failures = 0,
            None => self.gpu_failures += 1,
        }
        gpu
    }

    /// One sample; `None` when it cannot be taken now.
    fn sample(&mut self) -> Option<Usage> {
        let memory_total_bytes = self.memory_total()?;
        let answer = answer_of(self.ps.as_deref()?, &PS_ARGS)?;
        let now = Instant::now();
        let processes = parse_ps(&answer, self.pgid);
        if processes.is_empty() {
            return None;
        }
        let times: Vec<(u32, f64)> = processes
            .iter()
            .map(|p| {
                let exact = self
                    .proc_stat
                    .then(|| std::fs::read_to_string(format!("/proc/{}/stat", p.pid)).ok())
                    .flatten()
                    .and_then(|text| parse_proc_stat(&text))
                    .map(|ticks| ticks as f64 / self.ticks);
                (p.pid, exact.unwrap_or(p.cpu_seconds))
            })
            .collect();
        let elapsed = now.duration_since(self.last).as_secs_f64();
        self.last = now;
        let cpu_percent = self.meter.percent(&times, elapsed);
        // The program could have written anything there, or put a link in its place.
        let said = read_small_file(&self.run_dir.join(SAID_FILE), 4096)
            .or_else(|| read_small_file(&self.run_dir.join(OLD_SAID_FILE), 4096))
            .map(|data| parse_said(&data))
            .unwrap_or_default();
        Some(Usage {
            cpu_percent,
            cores: self.cores,
            memory_bytes: processes.iter().map(|p| p.memory_bytes).sum(),
            memory_total_bytes,
            processes: processes.len() as u32,
            gpu: self.gpu(),
            step: said.step,
            progress: said.progress,
        })
    }
}

/// Samples a Run on a thread of its own until it is stopped or dropped.
pub(crate) struct Sampler {
    samples: Receiver<Usage>,
    stop: Arc<AtomicBool>,
}

impl Sampler {
    /// `pgid`: the Run's process group; `run_dir`: its temporary directory; `path`: the
    /// `PATH` of its environment; `started`: when its process was started.
    pub(crate) fn start(
        pgid: u32,
        run_dir: PathBuf,
        path: Option<&OsStr>,
        started: Instant,
    ) -> Self {
        let (tx, samples) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let path = path.map(OsStr::to_owned);
        thread::spawn(move || {
            let mut machine = Machine::new(pgid, run_dir, path.as_deref(), started);
            let mut due = started + FIRST_SAMPLE;
            loop {
                while Instant::now() < due {
                    if stopped.load(Ordering::Relaxed) {
                        return;
                    }
                    thread::sleep(Duration::from_millis(25));
                }
                if stopped.load(Ordering::Relaxed) {
                    return;
                }
                if let Some(usage) = machine.sample()
                    && (stopped.load(Ordering::Relaxed) || tx.send(usage).is_err())
                {
                    return;
                }
                // A sample that took long is not made up for: the next one is in time again.
                let now = Instant::now();
                while due <= now {
                    due += INTERVAL;
                }
            }
        });
        Self { samples, stop }
    }

    /// The newest sample taken since the last call, if any. Never waits.
    pub(crate) fn latest(&self) -> Option<Usage> {
        let mut latest = None;
        loop {
            match self.samples.try_recv() {
                Ok(usage) => latest = Some(usage),
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => return latest,
            }
        }
    }

    /// No more samples: the process has ended. The thread ends by itself.
    pub(crate) fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Drop for Sampler {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn said(step: Option<&str>, progress: Option<(f64, f64)>) -> Said {
        Said {
            step: step.map(str::to_owned),
            progress: progress.map(|(done, total)| HowFar { done, total }),
        }
    }

    #[test]
    fn a_step_is_one_short_line_without_control_characters() {
        assert_eq!(clean_step("thermalising").as_deref(), Some("thermalising"));
        assert_eq!(clean_step("  sweep 3 \n").as_deref(), Some("sweep 3"));
        // The first line that says anything.
        assert_eq!(
            clean_step("\n\r\n  \nfirst\nsecond").as_deref(),
            Some("first")
        );
        assert_eq!(clean_step("a\rb").as_deref(), Some("a"));
        // Control characters go, whatever they were meant to do; other characters stay.
        assert_eq!(
            clean_step("a\x1b[31mb\0c\td\u{7f}e\u{85}f").as_deref(),
            Some("a[31mbcdef")
        );
        assert_eq!(
            clean_step("отжиг — 緩和 🙂").as_deref(),
            Some("отжиг — 緩和 🙂")
        );
        for nothing in ["", " ", "\n", "\x1b\0", " \t \r\n "] {
            assert_eq!(clean_step(nothing), None, "{nothing:?}");
        }
        // At most 120, counted the way the page counts, and never half a character.
        assert_eq!(clean_step(&"x".repeat(500)).unwrap().len(), MAX_STEP);
        assert_eq!(clean_step(&"x".repeat(120)).unwrap().len(), 120);
        let faces = clean_step(&"🙂".repeat(100)).unwrap();
        assert_eq!(faces.chars().count(), 60);
        assert_eq!(faces.encode_utf16().count(), MAX_STEP);
        let odd = clean_step(&format!("a{}", "🙂".repeat(100))).unwrap();
        assert_eq!(odd.encode_utf16().count(), 119);
    }

    #[test]
    fn how_far_needs_a_positive_total_and_keeps_done_within_it() {
        assert_eq!(
            how_far(3.0, 10.0),
            Some(HowFar {
                done: 3.0,
                total: 10.0
            })
        );
        assert_eq!(
            how_far(0.0, 0.5),
            Some(HowFar {
                done: 0.0,
                total: 0.5
            })
        );
        assert_eq!(
            how_far(11.0, 10.0),
            Some(HowFar {
                done: 10.0,
                total: 10.0
            })
        );
        assert_eq!(
            how_far(-1.0, 10.0),
            Some(HowFar {
                done: 0.0,
                total: 10.0
            })
        );
        for (done, total) in [
            (1.0, 0.0),
            (1.0, -5.0),
            (f64::NAN, 10.0),
            (1.0, f64::NAN),
            (f64::INFINITY, 10.0),
            (1.0, f64::INFINITY),
            (f64::NEG_INFINITY, 10.0),
        ] {
            assert_eq!(how_far(done, total), None, "{done} of {total}");
        }
    }

    #[test]
    fn what_the_code_wrote_is_checked() {
        // As runner.py writes it.
        assert_eq!(
            parse_said(br#"{"step": "thermalising", "done": 3, "total": 10}"#),
            said(Some("thermalising"), Some((3.0, 10.0)))
        );
        assert_eq!(
            parse_said(br#"{"step": "sweep"}"#),
            said(Some("sweep"), None)
        );
        assert_eq!(
            parse_said(br#"{"done": 2.5, "total": 4.0}"#),
            said(None, Some((2.5, 4.0)))
        );
        // As anyone could write it.
        assert_eq!(
            parse_said(br#"{"step": "a\nb\u0000", "done": 50, "total": 10}"#),
            said(Some("a"), Some((10.0, 10.0)))
        );
        assert_eq!(
            parse_said(br#"{"step": 5, "done": "3", "total": 10}"#),
            Said::default()
        );
        assert_eq!(
            parse_said(br#"{"step": "", "done": 1, "total": 0}"#),
            Said::default()
        );
        assert_eq!(parse_said(br#"{"done": 1}"#), Said::default());
        assert_eq!(
            parse_said(br#"{"done": -3, "total": 2}"#),
            said(None, Some((0.0, 2.0)))
        );
        let long = format!(r#"{{"step": "{}"}}"#, "y".repeat(4000));
        assert_eq!(parse_said(long.as_bytes()).step.unwrap().len(), MAX_STEP);
        for junk in [
            &b""[..],
            b"[1, 2]",
            b"\"step\"",
            b"{\"done\": NaN, \"total\": 1}",
            b"{\"done\": 1, \"total\": Infinity}",
            b"{\"done\": 1, \"total\": 1e999}",
            b"{\"step\": \"cut off",
            b"\xff\xfe",
            b"null",
        ] {
            assert_eq!(parse_said(junk), Said::default(), "{junk:?}");
        }
    }

    // Written by tqdm 4.67.3 into a file (`tqdm(total=…, desc=…)`, with `unit_scale=True`,
    // `postfix=…`, `total=None`, `colour='green'`, and bytes with `unit_divisor=1024`).
    const TQDM_START: &str = "  0%|          | 0/100 [00:00<?, ?it/s]";
    const TQDM_PLAIN: &str = " 45%|####5     | 45/100 [00:00<00:00, 827.92it/s]";
    const TQDM_DESC: &str = "sweep:  45%|####5     | 45/100 [00:00<00:00, 749.48it/s]";
    const TQDM_DESC_2: &str = "epoch 3:   7%|7         | 7/100 [00:00<00:00, 116.62it/s]";
    const TQDM_END: &str = "100%|##########| 100/100 [00:00<00:00, 1996.92it/s]";
    const TQDM_SCALED: &str = "download:  24%|##4       | 1.20k/5.00k [00:00<00:00, 20.0kit/s]";
    const TQDM_SCALED_START: &str = "download:   0%|          | 0.00/5.00k [00:00<?, ?it/s]";
    const TQDM_MIXED: &str = " 50%|#####     | 500k/1.00M [00:00<00:00, 9.68Mit/s]";
    const TQDM_POSTFIX: &str = "fit:  10%|#         | 1/10 [00:00<00:00, 19.85it/s, loss=0.5]";
    const TQDM_COLOUR: &str = " 45%|\x1b[32m####5     \x1b[0m| 45/100 [00:00<00:00, 755.67it/s]";
    const TQDM_BYTES: &str = "data.bin:  50%|#####     | 1.43M/2.86M [00:00<00:00, 26.5MB/s]";
    const TQDM_NO_TOTAL: &str = "45it [00:00, 787.85it/s]";

    #[test]
    fn a_tqdm_bar_says_how_far_and_what() {
        assert_eq!(parse_bar(TQDM_PLAIN), Some(said(None, Some((45.0, 100.0)))));
        assert_eq!(
            parse_bar(TQDM_DESC),
            Some(said(Some("sweep"), Some((45.0, 100.0))))
        );
        assert_eq!(
            parse_bar(TQDM_DESC_2),
            Some(said(Some("epoch 3"), Some((7.0, 100.0))))
        );
        assert_eq!(parse_bar(TQDM_START), Some(said(None, Some((0.0, 100.0)))));
        assert_eq!(parse_bar(TQDM_END), Some(said(None, Some((100.0, 100.0)))));
        assert_eq!(
            parse_bar(TQDM_SCALED),
            Some(said(Some("download"), Some((1200.0, 5000.0))))
        );
        assert_eq!(
            parse_bar(TQDM_SCALED_START),
            Some(said(Some("download"), Some((0.0, 5000.0))))
        );
        assert_eq!(
            parse_bar(TQDM_MIXED),
            Some(said(None, Some((500_000.0, 1_000_000.0))))
        );
        assert_eq!(
            parse_bar(TQDM_BYTES),
            Some(said(Some("data.bin"), Some((1_430_000.0, 2_860_000.0))))
        );
        assert_eq!(
            parse_bar(TQDM_POSTFIX),
            Some(said(Some("fit"), Some((1.0, 10.0))))
        );
        // The colour is inside the bar, which is not read.
        assert_eq!(
            parse_bar(TQDM_COLOUR),
            Some(said(None, Some((45.0, 100.0))))
        );
        // On a terminal the bar is drawn with blocks.
        assert_eq!(
            parse_bar("sweep:  45%|████▌     | 45/100 [00:10<00:12,  4.31it/s]"),
            Some(said(Some("sweep"), Some((45.0, 100.0))))
        );
        // A description that is itself several things.
        assert_eq!(
            parse_bar("L=16: T=2.3:  50%|#####     | 1/2 [00:00<00:00,  1.0it/s]"),
            Some(said(Some("L=16: T=2.3"), Some((1.0, 2.0))))
        );
        for other in [
            TQDM_NO_TOTAL,
            "",
            "hello",
            "45% done",
            "45%|",
            "45%| 45/100",
            "%|###| 45/100 [",
            "x%|###| 45/100 [",
            " 45%|###| 45/0 [00:10<00:12]",
            " 45%|###| a/b [00:10<00:12]",
            " 45%|###| 45 [00:10<00:12]",
            " 45%|###| -1/-5 [00:10<00:12]",
            " 45%|###| 1e3/1e5 [00:10<00:12]",
            " 45%|###| inf/nan [00:10<00:12]",
            "|  45/100 [",
        ] {
            assert_eq!(parse_bar(other), None, "{other:?}");
        }
    }

    #[test]
    fn the_last_bar_in_the_output_is_found_as_it_streams_by() {
        let mut bars = Bars::default();
        assert_eq!(bars.last(), None);
        bars.push("starting\n");
        assert_eq!(bars.last(), None);
        // tqdm draws the bar again in place: `\r`, then the whole line, no line end.
        bars.push(&format!("\r{TQDM_START}"));
        assert_eq!(bars.last(), Some(said(None, Some((0.0, 100.0)))));
        bars.push(&format!("\r{TQDM_DESC_2}"));
        assert_eq!(bars.last(), Some(said(Some("epoch 3"), Some((7.0, 100.0)))));
        // A bar that arrives in pieces counts once it is whole; until then the one before.
        let (head, tail) = TQDM_DESC.split_at(20);
        bars.push(&format!("\r{head}"));
        assert_eq!(bars.last(), Some(said(Some("epoch 3"), Some((7.0, 100.0)))));
        bars.push(tail);
        assert_eq!(bars.last(), Some(said(Some("sweep"), Some((45.0, 100.0)))));
        // Other output afterwards does not take the bar away.
        bars.push("\nloss 0.25\nsaving…");
        assert_eq!(bars.last(), Some(said(Some("sweep"), Some((45.0, 100.0)))));
        // A later bar replaces it.
        bars.push(&format!("\n{TQDM_END}\n"));
        assert_eq!(bars.last(), Some(said(None, Some((100.0, 100.0)))));

        // One character at a time gives the same.
        let mut slow = Bars::default();
        for c in format!("a\n\r{TQDM_START}\r{TQDM_DESC}").chars() {
            slow.push(c.encode_utf8(&mut [0; 4]));
        }
        assert_eq!(slow.last(), Some(said(Some("sweep"), Some((45.0, 100.0)))));

        // A flood without line ends is not kept, and what looks like a bar at its end is
        // not one.
        let mut flood = Bars::default();
        for _ in 0..1000 {
            flood.push(&"y".repeat(4096));
        }
        flood.push(TQDM_PLAIN);
        assert!(flood.pending.len() <= MAX_BAR_LINE);
        assert_eq!(flood.last(), None);
        flood.push(&format!("\r{TQDM_PLAIN}"));
        assert_eq!(flood.last(), Some(said(None, Some((45.0, 100.0)))));
    }

    // `LC_ALL=C /bin/ps -A -o pid= -o pgid= -o rss= -o time= -o stat=` on macOS 26, the lines
    // of process 1 and of group 58273: a Python program holding 200 MB after two busy
    // seconds, a child that had ended and was not collected, a `sleep`, and `ps` itself.
    const PS_MACOS: &str = concat!(
        "    1     1  23504 327:19.23 Ss  \n",
        "58273 58273 219824   0:02.04 S   \n",
        "58349 58273      0   0:00.00 Z   \n",
        "58350 58273   1136   0:00.00 S   \n",
        "58351 58273   1664   0:00.00 R   \n",
    );

    // `ps -A -o pid= -o pgid= -o rss= -o time= -o stat=` in the format procps prints on Linux (written by
    // hand: not captured).
    const PS_LINUX: &str = "      1       1 13312 00:00:07 Ss
      2       0     0 00:00:00 S
  41237   41237 98304 00:01:05 Rl
  41240   41237  2048 00:00:00 S
  41250   41250  4096 1-02:03:04 Sl
";

    #[test]
    fn ps_is_read_for_the_processes_of_the_group() {
        assert_eq!(
            parse_ps(PS_MACOS, 58273),
            vec![
                Process {
                    pid: 58273,
                    memory_bytes: 219_824 * 1024,
                    cpu_seconds: 2.04
                },
                Process {
                    pid: 58350,
                    memory_bytes: 1136 * 1024,
                    cpu_seconds: 0.0
                },
                Process {
                    pid: 58351,
                    memory_bytes: 1664 * 1024,
                    cpu_seconds: 0.0
                },
            ]
        );
        let init = parse_ps(PS_MACOS, 1);
        assert_eq!(init.len(), 1);
        assert!((init[0].cpu_seconds - (327.0 * 60.0 + 19.23)).abs() < 1e-9);
        assert_eq!(parse_ps(PS_MACOS, 4242), Vec::new());
        assert_eq!(
            parse_ps(PS_LINUX, 41237),
            vec![
                Process {
                    pid: 41237,
                    memory_bytes: 98_304 * 1024,
                    cpu_seconds: 65.0
                },
                Process {
                    pid: 41240,
                    memory_bytes: 2048 * 1024,
                    cpu_seconds: 0.0
                },
            ]
        );
        assert_eq!(
            parse_ps(PS_LINUX, 41250)[0].cpu_seconds,
            86_400.0 + 2.0 * 3600.0 + 3.0 * 60.0 + 4.0
        );
        // Lines that are not what was asked for are passed over.
        let odd = "PID PGID RSS TIME STAT\n\n7 7 x 0:00.01 S\n8 7 10 soon S\n9 7 10 0:00.01\n-1 7 10 0:00.01 S\n10 7 10 0:01.50 S extra\n";
        assert_eq!(
            parse_ps(odd, 7),
            vec![Process {
                pid: 10,
                memory_bytes: 10 * 1024,
                cpu_seconds: 1.5
            }]
        );
        for bad in [
            "", ":", "1", "1:", ":1", "1:2:3:4", "a:b", "1-", "-1:00", "1:+2", "1:2e1",
        ] {
            assert_eq!(cpu_time(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn what_left_the_runs_group_is_found_and_only_that_is_killed() {
        // `ps -A -o pid= -o ppid= -o pgid=`: a Julia Run (500) with two `Distributed`
        // workers in groups of their own (510, 511), a worker's child (512), a child in the
        // Run's group (501) whose own child left it (502), and strangers.
        let ps = "    1     0     1
  400     1   400
  500   400   500
  501   500   500
  502   501   502
  510   500   510
  511   500   511
  512   510   510
  600     1   600
  601   600   510
junk line
  7 8
";
        let escaped = parse_escaped(ps, 500);
        assert_eq!(
            escaped,
            [
                Escaped {
                    pid: 510,
                    pgid: 510
                },
                Escaped {
                    pid: 511,
                    pgid: 511
                },
                Escaped {
                    pid: 502,
                    pgid: 502
                },
                Escaped {
                    pid: 512,
                    pgid: 510
                },
            ]
        );
        assert_eq!(
            parse_escaped(ps, 600),
            [Escaped {
                pid: 601,
                pgid: 510
            }]
        );
        assert_eq!(parse_escaped(ps, 4242), []);
        // Later: 511 has ended and its id now belongs to a process in another group; the
        // rest are as they were. A group leader goes with its group; 512 is in 510's.
        let later = "  502     1   502\n  510     1   510\n  511     1   999\n  512   510   510\n";
        assert_eq!(still_escaped(later, &escaped), [-510, -502, 512]);
        assert_eq!(still_escaped("", &escaped), Vec::<i32>::new());
    }

    #[test]
    fn processor_time_from_proc_stat() {
        // The format of proc(5), written by hand; the name may contain spaces and brackets.
        let line = "41237 (python3) R 41230 41237 41230 34816 41237 4194304 5321 0 0 0 6480 25 0 0 20 0 3 0 8423012 152641536 24576 18446744073709551615 1 1 0 0 0 0 0 16781312 2 0 0 0 17 3 0 0 0 0 0 0 0 0 0 0 0 0 0\n";
        assert_eq!(parse_proc_stat(line), Some(6480 + 25));
        let odd =
            "7 (a) b (c d)) S 1 7 7 0 -1 4194560 100 0 0 0 12 30 0 0 20 0 1 0 100 1000 10 1\n";
        assert_eq!(parse_proc_stat(odd), Some(42));
        for bad in [
            "",
            "7 (x",
            "7 (x) S 1 2 3",
            "7 (x) S 1 7 7 0 -1 0 0 0 0 0 a b",
        ] {
            assert_eq!(parse_proc_stat(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn total_memory() {
        // `sysctl -n hw.memsize` on a Mac with 24 GB.
        assert_eq!(parse_memsize("25769803776\n"), Some(25_769_803_776));
        for bad in ["", "0\n", "hw.memsize: 25769803776\n", "-1", "24 GB"] {
            assert_eq!(parse_memsize(bad), None, "{bad:?}");
        }
        // The beginning of a Linux /proc/meminfo (not captured on this machine).
        let meminfo = "MemTotal:       16314508 kB\nMemFree:          254028 kB\nMemAvailable:    9817312 kB\n";
        assert_eq!(parse_meminfo(meminfo), Some(16_314_508 * 1024));
        for bad in [
            "",
            "MemFree: 5 kB\n",
            "MemTotal: lots kB\n",
            "MemTotal: 0 kB\n",
            "MemTotal: 5\n",
        ] {
            assert_eq!(parse_meminfo(bad), None, "{bad:?}");
        }
    }

    // `ioreg -r -d 1 -c IOAccelerator` on a Mac with an Apple M4 (macOS 26), with the long
    // properties that are not read left out.
    const IOREG_M4: &str = r#"+-o AGXAcceleratorG16G  <class AGXAcceleratorG16G, id 0x10000039b, registered, matched, active, busy 0 (21855 ms), retain 96>
    {
      "IOMatchedAtBoot" = Yes
      "vendor-id" = <6b100000>
      "GPURawCounterBundleName" = "AGXGPURawCounterBundle"
      "MetalPluginClassName" = "AGXG16GDevice"
      "AGCInfo" = {"fLastSubmissionPID"=7953,"fSubmissionsSinceLastCheck"=0,"fBusyCount"=0}
      "PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=5090181120,"Tiler Utilization %"=76,"recoveryCount"=0,"lastRecoveryTime"=0,"Renderer Utilization %"=75,"TiledSceneBytes"=1343488,"Device Utilization %"=76,"SplitSceneCount"=0,"Allocated PB Size"=110231552,"In use system memory"=873185280}
      "IOGLBundleName" = "AppleMetalOpenGLRenderer"
      "IOPowerManagement" = {"CurrentPowerState"=1,"CapabilityFlags"=2,"MaxPowerState"=1,"DriverPowerState"=1}
      "model" = "Apple M4"
      "gpu-core-count" = 10
      "IOClass" = "AGXAcceleratorG16G"
      "IOMatchCategory" = "IOAccelerator"
    }

"#;

    #[test]
    fn the_graphics_processor_from_ioreg() {
        assert_eq!(
            parse_ioreg(IOREG_M4),
            Some(Gpu {
                percent: 76.0,
                name: Some("Apple M4".into())
            })
        );
        // Two of them (an older Mac): the busier one, with its own name, written as data.
        let two = r#"+-o IntelAccelerator  <class IntelAccelerator, id 0x1000003a1>
    {
      "PerformanceStatistics" = {"Device Utilization %"=3,"GPU Activity(%)"=3}
      "model" = <"Intel UHD Graphics 630">
    }

+-o AMDRadeonX6000_AmdRadeonControllerNavi14  <class AMDRadeonX6000_AMDAccel, id 0x1000004b2>
    {
      "model" = <"AMD Radeon Pro 5500M">
      "PerformanceStatistics" = {"Device Utilization %"=41,"GPU Activity(%)"=41}
    }
"#;
        assert_eq!(
            parse_ioreg(two),
            Some(Gpu {
                percent: 41.0,
                name: Some("AMD Radeon Pro 5500M".into())
            })
        );
        // No name is no reason to say nothing; a number that is none is.
        assert_eq!(
            parse_ioreg(
                "+-o X  <class X>\n    {\n      \"PerformanceStatistics\" = {\"Device Utilization %\"=250}\n    }\n"
            ),
            Some(Gpu {
                percent: 100.0,
                name: None
            })
        );
        assert_eq!(
            parse_ioreg(
                "+-o X  <class X>\n    {\n      \"PerformanceStatistics\" = {\"Device Utilization %\"=7}\n      \"model\" = \"bad\x07name\"\n    }\n"
            ),
            Some(Gpu {
                percent: 7.0,
                name: None
            })
        );
        for nothing in [
            "",
            "+-o X  <class X>\n    {\n      \"model\" = \"Apple M4\"\n    }\n",
            "+-o X  <class X>\n    {\n      \"PerformanceStatistics\" = {\"Device Utilization %\"=many}\n    }\n",
            "\"Device Utilization %\"=50",
        ] {
            assert_eq!(parse_ioreg(nothing), None, "{nothing:?}");
        }
    }

    #[test]
    fn the_graphics_processor_from_nvidia_smi() {
        // The documented answer to `--query-gpu=utilization.gpu,name
        // --format=csv,noheader,nounits`.
        assert_eq!(
            parse_nvidia_smi("45, NVIDIA GeForce RTX 3090\n"),
            Some(Gpu {
                percent: 45.0,
                name: Some("NVIDIA GeForce RTX 3090".into())
            })
        );
        assert_eq!(
            parse_nvidia_smi("0, Tesla T4\n87, Tesla V100-SXM2-16GB\n12, Tesla T4\n"),
            Some(Gpu {
                percent: 87.0,
                name: Some("Tesla V100-SXM2-16GB".into())
            })
        );
        assert_eq!(
            parse_nvidia_smi("9\n"),
            Some(Gpu {
                percent: 9.0,
                name: None
            })
        );
        for nothing in [
            "",
            "[N/A], Tesla T4\n",
            "No devices were found\n",
            "utilization.gpu [%], name\n",
        ] {
            assert_eq!(parse_nvidia_smi(nothing), None, "{nothing:?}");
        }
    }

    #[test]
    fn processor_use_is_what_was_used_between_two_samples() {
        let mut meter = CpuMeter::default();
        // The first sample: everything used since the Run started.
        assert_eq!(meter.percent(&[(10, 0.4)], 0.8), 50.0);
        // One core fully busy for a second.
        assert_eq!(meter.percent(&[(10, 1.4)], 1.0), 100.0);
        // A child that started in between counts with all it has used; four cores busy.
        assert_eq!(meter.percent(&[(10, 2.4), (11, 3.0)], 1.0), 400.0);
        // The child is gone; the program idles.
        assert_eq!(meter.percent(&[(10, 2.4)], 1.0), 0.0);
        // Rounded to a tenth.
        assert_eq!(meter.percent(&[(10, 2.4123)], 1.0), 1.2);
        // A process id used again by a younger process, no time at all, or no processes.
        assert_eq!(meter.percent(&[(10, 0.1)], 1.0), 0.0);
        assert_eq!(meter.percent(&[(10, 5.0)], 0.0), 0.0);
        assert_eq!(meter.percent(&[], 1.0), 0.0);
    }

    #[test]
    fn usage_serialises_as_the_contract_says() {
        let usage = Usage {
            cpu_percent: 187.5,
            cores: 10,
            memory_bytes: 215_376 * 1024,
            memory_total_bytes: 25_769_803_776,
            processes: 2,
            gpu: Some(Gpu {
                percent: 76.0,
                name: Some("Apple M4".into()),
            }),
            step: Some("sweep".into()),
            progress: Some(HowFar {
                done: 45.0,
                total: 100.0,
            }),
        };
        assert_eq!(
            serde_json::to_value(&usage).unwrap(),
            serde_json::json!({
                "cpu_percent": 187.5, "cores": 10, "memory_bytes": 220545024u64,
                "memory_total_bytes": 25769803776u64, "processes": 2,
                "gpu": {"percent": 76.0, "name": "Apple M4"},
                "step": "sweep", "progress": {"done": 45.0, "total": 100.0}
            })
        );
        // What cannot be read or was not said is left out.
        let bare = Usage {
            gpu: None,
            step: None,
            progress: None,
            ..usage.clone()
        };
        assert_eq!(
            serde_json::to_value(&bare).unwrap(),
            serde_json::json!({
                "cpu_percent": 187.5, "cores": 10, "memory_bytes": 220545024u64,
                "memory_total_bytes": 25769803776u64, "processes": 2
            })
        );
        let unnamed = Usage {
            gpu: Some(Gpu {
                percent: 5.0,
                name: None,
            }),
            ..bare
        };
        assert_eq!(
            serde_json::to_value(&unnamed).unwrap()["gpu"],
            serde_json::json!({"percent": 5.0})
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_tool_that_does_not_answer_is_not_waited_for() {
        let begun = Instant::now();
        assert_eq!(answer_of(Path::new("/bin/sleep"), &["30"]), None);
        assert!(begun.elapsed() < COMMAND_TIMEOUT + Duration::from_millis(700));
        // One that answers, one that fails, one that is not there.
        assert_eq!(
            answer_of(Path::new("/bin/echo"), &["hi"]).as_deref(),
            Some("hi\n")
        );
        assert_eq!(answer_of(Path::new("/bin/ls"), &["/nowhere/at/all"]), None);
        assert_eq!(answer_of(Path::new("/nowhere/at/all"), &[]), None);
    }

    #[cfg(unix)]
    #[test]
    fn this_computer_can_be_sampled() {
        // The test's own process group, measured the way a Run's is.
        // SAFETY: `getpgrp` only reads.
        let pgid = unsafe { libc::getpgrp() } as u32;
        let dir = tempfile::tempdir().unwrap();
        let path = std::env::var_os("PATH");
        let mut machine =
            Machine::new(pgid, dir.path().to_owned(), path.as_deref(), Instant::now());
        if machine.ps.is_none() {
            eprintln!("SKIPPED: no ps on this machine");
            return;
        }
        std::fs::write(
            dir.path().join(SAID_FILE),
            br#"{"step": "testing", "done": 1, "total": 4}"#,
        )
        .unwrap();
        let usage = machine.sample().expect("a sample");
        assert!(usage.processes >= 1);
        assert!(usage.memory_bytes > 1024 * 1024, "{usage:?}");
        assert!(usage.memory_total_bytes > usage.memory_bytes, "{usage:?}");
        assert!(usage.cores >= 1);
        assert!(usage.cpu_percent >= 0.0 && usage.cpu_percent.is_finite());
        assert_eq!(usage.step.as_deref(), Some("testing"));
        assert_eq!(
            usage.progress,
            Some(HowFar {
                done: 1.0,
                total: 4.0
            })
        );
        if let Some(gpu) = &usage.gpu {
            assert!((0.0..=100.0).contains(&gpu.percent), "{gpu:?}");
        }
        // A link in the file's place is not followed.
        let outside = tempfile::tempdir().unwrap();
        std::fs::rename(dir.path().join(SAID_FILE), outside.path().join("said.json")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("said.json"), dir.path().join(SAID_FILE))
            .unwrap();
        let usage = machine.sample().expect("a sample");
        assert_eq!((usage.step, usage.progress), (None, None));
        // The file under its name before the rename is read when the new one is not there.
        std::fs::remove_file(dir.path().join(SAID_FILE)).unwrap();
        std::fs::write(
            dir.path().join(OLD_SAID_FILE),
            br#"{"step": "old name", "done": 2, "total": 4}"#,
        )
        .unwrap();
        let usage = machine.sample().expect("a sample");
        assert_eq!(usage.step.as_deref(), Some("old name"));
        std::fs::write(dir.path().join(SAID_FILE), br#"{"step": "new name"}"#).unwrap();
        let usage = machine.sample().expect("a sample");
        assert_eq!(usage.step.as_deref(), Some("new name"));
    }
}
