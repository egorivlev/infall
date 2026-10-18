//! What the Claude Code driver and the Runner share: a child process that leads its own
//! process group and is killed together with everything it started, and directories only
//! the owner can enter.

use std::fs;
use std::io;
use std::path::Path;
use std::process::{Child, Command, ExitStatus};
use std::thread;
use std::time::{Duration, Instant};

/// Puts the child in a process group of its own, so that it and everything it starts can be
/// signalled together.
pub fn own_process_group(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    job::no_console_window(command);
    #[cfg(not(any(unix, windows)))]
    let _ = command;
}

/// Puts the child in a session of its own: a process group of its own, and no controlling
/// terminal either. For an interactive shell, which would otherwise try to take the
/// terminal the app was started from.
pub fn own_session(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: `setsid` is async-signal-safe and touches no memory of the parent. It
        // cannot fail here (the new child is never a group leader); an error would only
        // leave the child in the parent's session.
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    job::no_console_window(command);
    #[cfg(not(any(unix, windows)))]
    let _ = command;
}

/// A child that leads its own process group. Dropping it kills the whole group.
///
/// Windows has no process groups: there the child is put into a job object right after it
/// was started, and killing the job kills it and everything it started from then on. There
/// is no polite request on Windows; stopping is always a kill.
pub struct Group {
    pub child: Child,
    reaped: bool,
    #[cfg(windows)]
    job: Option<job::Job>,
}

impl Group {
    /// `child` must have been started with [`own_process_group`] or [`own_session`].
    pub fn new(child: Child) -> Self {
        Self {
            #[cfg(windows)]
            job: job::Job::holding(&child),
            child,
            reaped: false,
        }
    }

    /// The id of the process, which is also the id of its group.
    pub fn id(&self) -> u32 {
        self.child.id()
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
    pub fn exited(&self) -> bool {
        if self.reaped {
            return true;
        }
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

    /// Has the leader exited?
    #[cfg(not(unix))]
    pub fn exited(&mut self) -> bool {
        self.reaped || !matches!(self.child.try_wait(), Ok(None))
    }

    fn wait_exit(&mut self, grace: Duration) {
        let deadline = Instant::now() + grace;
        while !self.exited() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
    }

    /// Kills whatever is left of the group and collects the leader's exit status. `None`
    /// when that was already done.
    pub fn kill_and_reap(&mut self) -> Option<ExitStatus> {
        if self.reaped {
            return None;
        }
        #[cfg(unix)]
        self.signal(libc::SIGKILL);
        #[cfg(not(unix))]
        {
            // Windows: everything in the job; then the process itself, in case there is no job.
            #[cfg(windows)]
            if let Some(job) = &self.job {
                job.kill();
            }
            let _ = self.child.kill();
        }
        self.reaped = true;
        self.child.wait().ok()
    }

    /// The work is over: give the process `grace` to exit by itself, then remove whatever is
    /// left of its group. Returns the leader's exit status.
    pub fn finish(&mut self, grace: Duration) -> Option<ExitStatus> {
        if self.reaped {
            return None;
        }
        self.wait_exit(grace);
        self.kill_and_reap()
    }

    /// Stop now: ask politely, wait `grace`, then kill the whole group.
    pub fn terminate(&mut self, grace: Duration) -> Option<ExitStatus> {
        if self.reaped {
            return None;
        }
        #[cfg(unix)]
        {
            self.signal(libc::SIGTERM);
            self.wait_exit(grace);
        }
        // Nothing was asked, so there is nothing to wait for.
        #[cfg(not(unix))]
        let _ = grace;
        self.kill_and_reap()
    }
}

impl Drop for Group {
    fn drop(&mut self) {
        self.kill_and_reap();
    }
}

/// Creates `dir` (and its parents) so that only the owner can enter it.
pub fn make_private_dir(dir: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

/// Is `path` a file this user could execute?
pub fn is_executable_file(path: &Path) -> bool {
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

/// Windows: the job object that stands in for the process group, and starting console
/// programs without a console window. Four calls into kernel32, which every Windows program
/// links anyway; no crate is needed for them.
#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command};

    /// `CREATE_NO_WINDOW`: the app has no console, and without this flag Windows would open
    /// a console window for every console program it starts (`python.exe`, `claude.exe`).
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    pub fn no_console_window(command: &mut Command) {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    // A `HANDLE` is pointer-sized; `isize` here, so that a `Job` can move between threads.
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *const u8, name: *const u16) -> isize;
        fn AssignProcessToJobObject(job: isize, process: isize) -> i32;
        fn TerminateJobObject(job: isize, exit_code: u32) -> i32;
        fn CloseHandle(handle: isize) -> i32;
    }

    pub struct Job(isize);

    impl Job {
        /// A new job with `child` in it. Processes `child` starts from now on are in it
        /// too; one it started in the instant before is not. `None` if Windows refuses,
        /// and then only the process itself can be killed.
        pub fn holding(child: &Child) -> Option<Self> {
            // SAFETY: both arguments may be null (default security, no name). The process
            // handle belongs to `child`, which outlives this call.
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job == 0 {
                    return None;
                }
                let job = Self(job);
                (AssignProcessToJobObject(job.0, child.as_raw_handle() as isize) != 0)
                    .then_some(job)
            }
        }

        /// Ends every process in the job.
        pub fn kill(&self) {
            // SAFETY: the handle is a job this value owns. An error is fine to ignore.
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: the handle is owned by this value and closed only here.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
