//! Toolchains: what the Runner starts for a Run in one language (docs/specs/desktop.md,
//! "Languages — Runs in more than Python"). A Run only names its language; which program
//! that starts, with which arguments, is set here by the Member, on this device.
//!
//! Two are built in: `python` (M8) and `qsharp` (hosted by the chosen Python). Every other
//! language is a command: a program on this computer, its arguments with `{file}` standing
//! for the Run's file, and that file's extension. Presets offer four; any other is added by
//! hand.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::python::{self, EnvVars, env_value, home_dir};
use crate::settings::Toolchain;

pub const PYTHON: &str = "python";
pub const QSHARP: &str = "qsharp";
/// What stands for the Run's file in a Toolchain's arguments.
pub const FILE: &str = "{file}";
pub const MAX_LANGUAGES: usize = 24;
pub const MAX_ARGS: usize = 16;
pub const MAX_ARG_CHARS: usize = 200;
pub const MAX_NAME_CHARS: usize = 40;
pub const MAX_VERSION_CHARS: usize = 40;
/// At most this many programs are asked for their version per preset.
const MAX_FOUND: usize = 4;

/// Is `id` a language id: `^[a-z][a-z0-9_-]{0,23}$`.
pub fn valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (1..=24).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-'))
}

/// A language id a command Toolchain may have: any but the two built in.
pub fn is_command_id(id: &str) -> bool {
    valid_id(id) && id != PYTHON && id != QSHARP
}

/// Not empty, at most `max` characters, no control characters.
pub fn short_plain(text: &str, max: usize) -> bool {
    !text.is_empty() && text.chars().count() <= max && !text.chars().any(char::is_control)
}

/// A language that can be set up from a preset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Preset {
    pub id: &'static str,
    pub name: &'static str,
    /// The program's names on macOS and Linux, and on Windows.
    pub unix: &'static [&'static str],
    pub windows: &'static [&'static str],
    pub ext: &'static str,
}

/// Julia, R, JavaScript and Shell. Shell is bash, on every system: on Windows the `bash.exe`
/// of Git for Windows when there is one (never the one in System32, which starts WSL, a
/// Linux that cannot open the Run's Windows path). cmd.exe and PowerShell are other
/// languages, which can be added by hand (`.bat` and `.cmd` files are refused as programs).
pub const PRESETS: &[Preset] = &[
    Preset {
        id: "julia",
        name: "Julia",
        unix: &["julia"],
        windows: &["julia.exe"],
        ext: "jl",
    },
    Preset {
        id: "r",
        name: "R",
        unix: &["Rscript"],
        windows: &["Rscript.exe"],
        ext: "R",
    },
    Preset {
        id: "javascript",
        name: "JavaScript",
        unix: &["node"],
        windows: &["node.exe"],
        ext: "mjs",
    },
    Preset {
        id: "shell",
        name: "Shell",
        unix: &["bash"],
        windows: &["bash.exe"],
        ext: "sh",
    },
];

pub fn preset(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.id == id)
}

/// How a language is named: the built-in names, a Toolchain's own name, a preset's, else
/// the id itself.
pub fn language_name(id: &str, toolchain: Option<&Toolchain>) -> String {
    match id {
        PYTHON => "Python".into(),
        QSHARP => "Q#".into(),
        _ => toolchain
            .map(|t| t.name.clone())
            .or_else(|| preset(id).map(|p| p.name.to_owned()))
            .unwrap_or_else(|| id.to_owned()),
    }
}

/// The rules a saved Toolchain must keep, apart from its program existing: a name, an
/// absolute program path, at most 16 arguments of at most 200 characters with `{file}` in
/// exactly one place, and a plain extension. The error is a plain sentence.
pub fn check_shape(t: &Toolchain) -> Result<(), String> {
    if !short_plain(t.name.trim(), MAX_NAME_CHARS) || t.name.trim() != t.name {
        return Err("Give the language a name of at most 40 characters.".into());
    }
    if !Path::new(&t.program).is_absolute() || t.program.contains('\0') {
        return Err(if cfg!(windows) {
            "Enter the full path of the program, starting with the drive (C:\\…)."
        } else {
            "Enter the full path of the program, starting with /."
        }
        .into());
    }
    if cfg!(windows) && is_batch_file(Path::new(&t.program)) {
        return Err(
            "A .bat or .cmd file cannot be a language's program: the command interpreter would \
             read its arguments its own way. Point at the program itself."
                .into(),
        );
    }
    if t.args.len() > MAX_ARGS {
        return Err("A language takes at most 16 arguments.".into());
    }
    if t.args
        .iter()
        .any(|a| a.chars().count() > MAX_ARG_CHARS || a.contains('\0'))
    {
        return Err("Each argument is at most 200 characters.".into());
    }
    let places: usize = t.args.iter().map(|a| a.matches(FILE).count()).sum();
    if places != 1 {
        return Err("Put {file}, which stands for the Run's file, in exactly one argument.".into());
    }
    let ext_ok = (1..=8).contains(&t.ext.len()) && t.ext.bytes().all(|b| b.is_ascii_alphanumeric());
    if !ext_ok {
        return Err("The file extension is 1 to 8 letters or digits, without the dot.".into());
    }
    Ok(())
}

fn is_batch_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("bat") || e.eq_ignore_ascii_case("cmd"))
}

/// The arguments a Run's process is started with: each argument as it is, `{file}` replaced
/// by the Run's file. No shell reads them.
pub fn arguments(args: &[String], file: &Path) -> Vec<OsString> {
    args.iter()
        .map(|arg| match arg.split_once(FILE) {
            Some((before, after)) => {
                let mut out = OsString::from(before);
                out.push(file.as_os_str());
                out.push(after);
                out
            }
            None => OsString::from(arg),
        })
        .collect()
}

/// The first line a program wrote, control characters removed, at most 40 characters.
pub fn version_line(output: &str) -> Option<String> {
    first_line(output, MAX_VERSION_CHARS)
}

/// The first line a program wrote, control characters removed, at most `max` characters.
fn first_line(output: &str, max: usize) -> Option<String> {
    let line = output.lines().map(str::trim).find(|l| !l.is_empty())?;
    let clean: String = line.chars().filter(|c| !c.is_control()).take(max).collect();
    let clean = clean.trim().to_owned();
    (!clean.is_empty()).then_some(clean)
}

/// `<program> --version`, five seconds, both streams (some programs print their version on
/// standard error). When it ends well (exit code 0): its first line, `None` if it printed
/// nothing. Otherwise (it crashed, failed, did not answer, could not be started) it gave no
/// version, whatever it printed: the error is a short plain sentence saying it is not
/// working, for the settings window. Such a program may still be set up by hand.
pub fn ask_version(program: &Path, env: &EnvVars) -> Result<Option<String>, String> {
    let mut command = Command::new(program);
    command
        .arg("--version")
        .env_clear()
        .envs(env.iter().map(|(k, v)| (k, v)))
        .current_dir(std::env::temp_dir());
    // (`capture_status` starts it in a group of its own, without a console window on
    // Windows.)
    match python::capture_status(command, python::VERSION_TIMEOUT, 4096, true, false) {
        Ok((status, out)) => {
            let out = String::from_utf8_lossy(&out);
            if status.success() {
                Ok(version_line(&out))
            } else {
                Err(not_working(
                    ended(status),
                    first_line(&out, MAX_SAID_CHARS + 1).as_deref(),
                ))
            }
        }
        Err(python::NoStatus::TimedOut) => Err(not_working(
            format!(
                "It did not answer within {} seconds when asked its version.",
                python::VERSION_TIMEOUT.as_secs()
            ),
            None,
        )),
        Err(python::NoStatus::NotStarted) => {
            Err(not_working("It could not be started.".into(), None))
        }
    }
}

/// At most this many characters say why a program is not working.
pub const MAX_PROBLEM_CHARS: usize = 160;
/// Of which at most this many are what it printed.
const MAX_SAID_CHARS: usize = 60;

/// How a version probe that did not end well ended, as a sentence.
fn ended(status: std::process::ExitStatus) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return format!("It crashed (signal {signal}) when asked its version.");
        }
    }
    match status.code() {
        Some(code) => format!("It failed (exit code {code}) when asked its version."),
        None => "It failed when asked its version.".into(),
    }
}

/// `why`, then the start of what the program printed, if anything.
fn not_working(why: String, said: Option<&str>) -> String {
    let Some(said) = said else {
        return why;
    };
    let mut cut: String = said.chars().take(MAX_SAID_CHARS).collect();
    if said.chars().count() > MAX_SAID_CHARS {
        cut.push('…');
    }
    format!("{why} It said: {cut}")
}

/// Checks a program path the Member typed: an absolute path to an executable file (on
/// Windows, not a `.bat` or `.cmd`). Returns it as it will be saved.
pub fn check_program(typed: &str) -> Result<String, String> {
    let typed = typed.trim();
    let path = Path::new(typed);
    if typed.is_empty() {
        return Err("Enter the full path of the program.".into());
    }
    if !path.is_absolute() || typed.contains('\0') {
        return Err(if cfg!(windows) {
            "Enter the full path of the program, starting with the drive (C:\\…)."
        } else {
            "Enter the full path of the program, starting with /."
        }
        .into());
    }
    if cfg!(windows) && is_batch_file(path) {
        return Err(
            "A .bat or .cmd file cannot be a language's program: the command interpreter would \
             read its arguments its own way. Point at the program itself."
                .into(),
        );
    }
    if path.is_dir() {
        return Err("That is a folder. Enter the path of the program itself.".into());
    }
    if !qoop_proc::is_executable_file(path) {
        return Err("There is no program at that path.".into());
    }
    Ok(typed.to_owned())
}

/// The folders to look for a preset's program in: the shell's `PATH`, then where installers
/// usually put them.
fn search_dirs(env: &EnvVars) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = env_value(env, "PATH")
        .map(|p| std::env::split_paths(p).collect())
        .unwrap_or_default();
    let home = home_dir(env).map(PathBuf::from);
    if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramW6432"] {
            if let Some(base) = env_value(env, var).map(PathBuf::from) {
                dirs.push(base.join("nodejs"));
                dirs.push(base.join("Git").join("bin"));
                dirs.extend(versioned(&base.join("R"), "R-", &["bin"]));
            }
        }
        if let Some(local) = env_value(env, "LOCALAPPDATA").map(PathBuf::from) {
            dirs.extend(versioned(&local.join("Programs"), "Julia", &["bin"]));
            dirs.push(local.join("Programs").join("Git").join("bin"));
        }
        if let Some(home) = &home {
            dirs.push(home.join(".juliaup").join("bin"));
        }
    } else {
        if let Some(home) = &home {
            dirs.push(home.join(".juliaup/bin"));
        }
        for usual in [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/Library/Frameworks/R.framework/Resources/bin",
        ] {
            dirs.push(PathBuf::from(usual));
        }
        dirs.extend(versioned(
            Path::new("/Applications"),
            "Julia-",
            &["Contents", "Resources", "julia", "bin"],
        ));
    }
    dirs.retain(|d| d.is_absolute());
    dirs
}

/// `<root>/<prefix>…/<rest>` for each folder of `root` whose name starts with `prefix`,
/// newest-looking first.
fn versioned(root: &Path, prefix: &str, rest: &[&str]) -> Vec<PathBuf> {
    let mut names: Vec<String> = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.starts_with(prefix))
        .collect();
    names.sort_by(|a, b| b.cmp(a));
    names.truncate(8);
    names
        .into_iter()
        .map(|n| rest.iter().fold(root.join(n), |p, r| p.join(r)))
        .collect()
}

/// WSL's `bash.exe` in System32 (or the store's) runs Linux, which cannot open the Run's file.
fn is_wsl_launcher(path: &Path, env: &EnvVars) -> bool {
    if !cfg!(windows) {
        return false;
    }
    let text = path.to_string_lossy().to_ascii_lowercase();
    let system = env_value(env, "SystemRoot")
        .map(|r| r.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_else(|| "c:\\windows".into());
    text.starts_with(&system) || text.contains("\\windowsapps\\")
}

/// A program found for a preset, with what it said its version is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FoundProgram {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Set when it is there but not working: asked its version, it crashed, failed or did
    /// not answer. Why, as a short plain sentence. It has no version then.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

/// The programs a preset could use on this device, each once (a link and what it points at
/// are one), each asked its version: at most four. Those that work come first, so that the
/// first is never a broken one while a working one was found.
pub fn find_programs(preset: &Preset, env: &EnvVars) -> Vec<FoundProgram> {
    let names = if cfg!(windows) {
        preset.windows
    } else {
        preset.unix
    };
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut found = Vec::new();
    for dir in search_dirs(env) {
        for name in names {
            let candidate = dir.join(name);
            if !qoop_proc::is_executable_file(&candidate) || is_wsl_launcher(&candidate, env) {
                continue;
            }
            let real = candidate
                .canonicalize()
                .unwrap_or_else(|_| candidate.clone());
            if seen.contains(&real) || found.len() == MAX_FOUND {
                continue;
            }
            seen.push(real);
            let Some(path) = candidate.to_str().map(str::to_owned) else {
                continue;
            };
            let (version, problem) = match ask_version(&candidate, env) {
                Ok(version) => (version, None),
                Err(problem) => (None, Some(problem)),
            };
            found.push(FoundProgram {
                path,
                version,
                problem,
            });
        }
    }
    // Stable: otherwise in the order they were found.
    found.sort_by_key(|f| f.problem.is_some());
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn toolchain(args: &[&str]) -> Toolchain {
        Toolchain {
            name: "Fake".into(),
            program: if cfg!(windows) {
                "C:\\bin\\fake.exe".into()
            } else {
                "/bin/fake".into()
            },
            args: args.iter().map(|a| (*a).to_owned()).collect(),
            ext: "fk".into(),
            version: None,
            problem: None,
            off: false,
        }
    }

    #[test]
    fn language_ids() {
        for ok in [
            "python",
            "qsharp",
            "julia",
            "r",
            "c-sharp",
            "x_1",
            &"a".repeat(24),
        ] {
            assert!(valid_id(ok), "{ok}");
        }
        for bad in [
            "",
            "Julia",
            "1r",
            "-x",
            "a b",
            "a.b",
            "é",
            &"a".repeat(25),
            "r\n",
        ] {
            assert!(!valid_id(bad), "{bad:?}");
        }
        assert!(!is_command_id("python") && !is_command_id("qsharp"));
        assert!(is_command_id("julia"));
        assert_eq!(language_name("qsharp", None), "Q#");
        assert_eq!(language_name("r", None), "R");
        assert_eq!(language_name("javascript", None), "JavaScript");
        assert_eq!(language_name("haskell", None), "haskell");
        assert_eq!(
            language_name("haskell", Some(&toolchain(&["{file}"]))),
            "Fake"
        );
    }

    #[test]
    fn what_a_command_toolchain_must_keep_to() {
        assert!(check_shape(&toolchain(&["{file}"])).is_ok());
        assert!(check_shape(&toolchain(&["--quiet", "--file={file}", "-x"])).is_ok());
        let refused = |t: &Toolchain| check_shape(t).unwrap_err();
        assert!(refused(&toolchain(&[])).contains("{file}"));
        assert!(refused(&toolchain(&["a"])).contains("{file}"));
        assert!(refused(&toolchain(&["{file}", "{file}"])).contains("exactly one"));
        assert!(refused(&toolchain(&["{file}{file}"])).contains("exactly one"));
        let many: Vec<&str> = std::iter::once("{file}").chain(["x"; 16]).collect();
        assert!(refused(&toolchain(&many)).contains("16"));
        let long = "y".repeat(201);
        assert!(refused(&toolchain(&["{file}", &long])).contains("200"));
        for ext in ["", ".jl", "j l", "toolongext", "é"] {
            let t = Toolchain {
                ext: ext.into(),
                ..toolchain(&["{file}"])
            };
            assert!(refused(&t).contains("extension"), "{ext:?}");
        }
        for name in ["", " x", &"n".repeat(41), "a\nb"] {
            let t = Toolchain {
                name: name.into(),
                ..toolchain(&["{file}"])
            };
            assert!(refused(&t).contains("name"), "{name:?}");
        }
        let t = Toolchain {
            program: "fake".into(),
            ..toolchain(&["{file}"])
        };
        assert!(refused(&t).contains("full path"));
    }

    #[test]
    fn the_file_takes_the_place_of_its_placeholder_and_nothing_else_changes() {
        let t = toolchain(&["--quiet", "--file={file}.run", "$HOME", "*", "a b"]);
        let file = Path::new("/tmp/run dir/main.fk");
        assert_eq!(
            arguments(&t.args, file),
            [
                "--quiet",
                "--file=/tmp/run dir/main.fk.run",
                "$HOME",
                "*",
                "a b"
            ]
            .map(OsString::from)
        );
    }

    #[test]
    fn version_lines() {
        assert_eq!(
            version_line("julia version 1.11.2\n").as_deref(),
            Some("julia version 1.11.2")
        );
        assert_eq!(
            version_line("\n\n  v22.1.0  \nmore").as_deref(),
            Some("v22.1.0")
        );
        assert_eq!(
            version_line("GNU bash, version 5.2.37(1)-release (aarch64-apple-darwin24)")
                .map(|v| v.chars().count()),
            Some(40)
        );
        assert_eq!(
            version_line("a\u{1b}[31mred\u{7}").as_deref(),
            Some("a[31mred")
        );
        assert_eq!(version_line("   \n\t\n"), None);
        assert_eq!(version_line(""), None);
    }

    #[cfg(unix)]
    #[test]
    fn programs_are_checked_and_asked_their_version() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = |name: &str, body: &str| {
            let path = dir.path().join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        };
        let env: EnvVars = std::env::vars_os().collect();
        // On standard error, exit code 0: that is its version.
        let talks = script("talks", "echo 'fake 1.2.3' >&2");
        assert_eq!(ask_version(&talks, &env), Ok(Some("fake 1.2.3".into())));
        let quiet = script("quiet", "exit 0");
        assert_eq!(ask_version(&quiet, &env), Ok(None));
        let silent = script("silent", "exit 1");
        assert_eq!(
            ask_version(&silent, &env),
            Err("It failed (exit code 1) when asked its version.".into())
        );
        // What a program that cannot load its libraries does: says so, and aborts. That text
        // is not its version.
        let crashes = script(
            "crashes",
            "echo 'dyld[27529]: Library not loaded: /opt/homebrew/opt/llhttp/lib/libllhttp.9.3.dylib' >&2\n\
             echo '  Referenced from: /opt/homebrew/Cellar/node/25.2.1/bin/node' >&2\n\
             kill -ABRT $$",
        );
        assert_eq!(
            ask_version(&crashes, &env),
            Err(
                "It crashed (signal 6) when asked its version. It said: dyld[27529]: Library \
                 not loaded: /opt/homebrew/opt/llhttp/li…"
                    .into()
            )
        );
        let fails = script("fails", "echo 'v1.0 but broken'\nexit 2");
        assert_eq!(
            ask_version(&fails, &env),
            Err("It failed (exit code 2) when asked its version. It said: v1.0 but broken".into())
        );
        let gone = dir.path().join("gone");
        assert_eq!(
            ask_version(&gone, &env),
            Err("It could not be started.".into())
        );
        for problem in [
            ask_version(&crashes, &env).unwrap_err(),
            ask_version(&silent, &env).unwrap_err(),
        ] {
            assert!(short_plain(&problem, MAX_PROBLEM_CHARS), "{problem}");
        }
        assert_eq!(
            check_program(&format!(" {} ", talks.display())),
            Ok(talks.to_str().unwrap().to_owned())
        );
        assert!(check_program("talks").unwrap_err().contains("full path"));
        assert!(
            check_program(dir.path().to_str().unwrap())
                .unwrap_err()
                .contains("folder")
        );
        let text = dir.path().join("notes.txt");
        std::fs::write(&text, "x").unwrap();
        assert_eq!(
            check_program(text.to_str().unwrap()).unwrap_err(),
            "There is no program at that path."
        );

        // A preset's program is looked for on the shell's PATH; the same program twice is
        // listed once.
        let bin = dir.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        let julia = bin.join("julia");
        std::fs::write(&julia, "#!/bin/sh\necho 'julia version 9.9.9'\n").unwrap();
        std::fs::set_permissions(&julia, std::fs::Permissions::from_mode(0o755)).unwrap();
        let env: EnvVars = vec![
            ("PATH".into(), std::env::join_paths([&bin, &bin]).unwrap()),
            ("HOME".into(), dir.path().into()),
        ];
        let found = find_programs(preset("julia").unwrap(), &env);
        let ours: Vec<_> = found
            .iter()
            .filter(|f| f.path.starts_with(dir.path().to_str().unwrap()))
            .collect();
        assert_eq!(
            ours,
            [&FoundProgram {
                path: julia.to_str().unwrap().to_owned(),
                version: Some("julia version 9.9.9".into()),
                problem: None,
            }]
        );
    }

    /// A program found that crashes when asked its version is listed as there but not
    /// working, after the ones that work, and never with what it printed as its version.
    #[cfg(unix)]
    #[test]
    fn a_program_that_crashes_is_found_but_not_working_and_not_first() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let program = |dir: &Path, body: &str| {
            std::fs::create_dir_all(dir).unwrap();
            let path = dir.join("node");
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        };
        let broken = program(
            &dir.path().join("first"),
            "echo 'dyld[27285]: Library not loaded: /opt/homebrew/opt/llhttp/lib/x.dylib' >&2\n\
             kill -ABRT $$",
        );
        let working = program(&dir.path().join("second"), "echo v25.2.1");
        let env: EnvVars = vec![
            (
                "PATH".into(),
                std::env::join_paths([broken.parent().unwrap(), working.parent().unwrap()])
                    .unwrap(),
            ),
            ("HOME".into(), dir.path().into()),
        ];
        let found = find_programs(preset("javascript").unwrap(), &env);
        let ours: Vec<_> = found
            .iter()
            .filter(|f| f.path.starts_with(dir.path().to_str().unwrap()))
            .collect();
        assert_eq!(ours.len(), 2, "{found:?}");
        assert_eq!(ours[0].path, working.to_str().unwrap());
        assert_eq!(
            (ours[0].version.as_deref(), ours[0].problem.as_deref()),
            (Some("v25.2.1"), None)
        );
        assert_eq!(ours[1].path, broken.to_str().unwrap());
        assert_eq!(ours[1].version, None);
        let problem = ours[1].problem.as_deref().unwrap();
        assert!(
            problem.starts_with("It crashed (signal 6) when asked its version. It said: dyld["),
            "{problem}"
        );
        // Working ones before every broken one, whatever else is on this machine.
        let first_broken = found.iter().position(|f| f.problem.is_some()).unwrap();
        assert!(found[first_broken..].iter().all(|f| f.problem.is_some()));
        // The settings window gets `problem` only when there is one: older readers see a
        // program without a version, as before.
        assert_eq!(
            serde_json::to_value(ours[1]).unwrap(),
            serde_json::json!({"path": broken.to_str().unwrap(), "problem": problem})
        );
        assert_eq!(
            serde_json::to_value(ours[0]).unwrap(),
            serde_json::json!({"path": working.to_str().unwrap(), "version": "v25.2.1"})
        );
    }
}
