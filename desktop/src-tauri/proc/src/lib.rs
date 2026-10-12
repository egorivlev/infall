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
    #[cfg(not(unix))]
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
    #[cfg(not(unix))]
    let _ = command;
}

/// A child that leads its own process group. Dropping it kills the whole group.
pub struct Group {
    pub child: Child,
    reaped: bool,
}

impl Group {
    /// `child` must have been started with [`own_process_group`] or [`own_session`].
    pub fn new(child: Child) -> Self {
        Self {
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

    fn wait_exit(&self, grace: Duration) {
        #[cfg(unix)]
        {
            let deadline = Instant::now() + grace;
            while !self.exited() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
        }
        #[cfg(not(unix))]
        let _ = (grace, Instant::now(), thread::yield_now);
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
        let _ = self.child.kill();
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
        self.signal(libc::SIGTERM);
        self.wait_exit(grace);
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
