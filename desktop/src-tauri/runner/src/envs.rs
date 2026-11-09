//! Python environments on this device (docs/specs/pdf-sources.md, Part 2): the ones found
//! (conda environments, pyenv versions, a `venv`/`.venv` in the working folder, and the
//! interpreters on the shell's `PATH`, which `python::find` lists), the ones added by hand,
//! and which of them a name a Run asks for means here.
//!
//! A Run's `env` is only a wish. It is looked up in this order: the Member's own answer for
//! that name (`Settings::names`), an environment added by hand under that name, then a found
//! environment of exactly that name, if there is exactly one. Anything else is asked, once.
//!
//! Looking only reads directories and small files: it starts no program, so it can run for
//! `status()` and before every Run. Versions are asked for in the settings window only.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::python::{EnvVars, env_value, home_dir};
use crate::settings::Settings;

/// How many environments may be added by hand, and how many names remembered.
pub const MAX_ADDED: usize = 64;
pub const MAX_NAMES: usize = 256;
/// A name a Run may ask for: at most this many characters.
pub const MAX_NAME_CHARS: usize = 60;
/// At most this many environments are listed from one place (a conda root's `envs`, …).
const MAX_PER_PLACE: usize = 64;

/// Where an environment was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Conda,
    Pyenv,
    Venv,
    /// On the shell's `PATH` (`python::find`).
    Path,
    /// Added by hand in the settings window.
    Added,
}

/// One environment: the name it goes by here, and its interpreter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Found {
    pub name: String,
    pub kind: Kind,
    /// The full path of its interpreter.
    pub path: String,
}

/// Is this a name a Run may ask for? One line of 1–60 characters, no control characters,
/// no space at either end.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= MAX_NAME_CHARS
        && name.trim() == name
        && !name
            .chars()
            .any(|c| c.is_control() || crate::inspect::is_hidden(c))
}

/// The interpreter of an environment whose prefix is `prefix`, if there is one.
fn python_in(prefix: &Path) -> Option<PathBuf> {
    let candidates: &[&str] = if cfg!(windows) {
        // conda: python.exe in the prefix; venv: in Scripts.
        &["python.exe", "Scripts\\python.exe"]
    } else {
        &["bin/python3", "bin/python"]
    };
    candidates
        .iter()
        .map(|c| prefix.join(c))
        .find(|p| qoop_proc::is_executable_file(p))
}

fn subdirs(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut found: Vec<(String, PathBuf)> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| Some((e.file_name().into_string().ok()?, e.path())))
        .filter(|(name, _)| !name.starts_with('.'))
        .collect();
    found.sort();
    found.truncate(MAX_PER_PLACE);
    found
}

/// The places a conda (or mamba) installation usually is, its own `base` included.
fn conda_roots(env: &EnvVars) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    // What the shell says: `CONDA_EXE` is `<root>/bin/conda` (`<root>\Scripts\conda.exe`).
    if let Some(exe) = env_value(env, "CONDA_EXE").map(PathBuf::from)
        && let Some(root) = exe.parent().and_then(Path::parent)
    {
        roots.push(root.to_owned());
    }
    for name in ["MAMBA_ROOT_PREFIX", "CONDA_ROOT"] {
        if let Some(root) = env_value(env, name) {
            roots.push(PathBuf::from(root));
        }
    }
    if let Some(home) = home_dir(env).map(PathBuf::from) {
        for dir in [
            "miniconda3",
            "anaconda3",
            "miniforge3",
            "mambaforge",
            "micromamba",
            "opt/miniconda3",
            "opt/anaconda3",
            ".conda",
        ] {
            roots.push(home.join(dir));
        }
    }
    if cfg!(windows) {
        for var in ["LOCALAPPDATA", "ProgramData"] {
            if let Some(base) = env_value(env, var).map(PathBuf::from) {
                for dir in ["miniconda3", "anaconda3", "miniforge3"] {
                    roots.push(base.join(dir));
                }
            }
        }
    } else {
        for dir in [
            "/opt/homebrew/Caskroom/miniforge/base",
            "/usr/local/Caskroom/miniforge/base",
            "/opt/homebrew/Caskroom/miniconda/base",
            "/usr/local/Caskroom/miniconda/base",
            "/opt/miniconda3",
            "/opt/anaconda3",
            "/opt/conda",
        ] {
            roots.push(PathBuf::from(dir));
        }
    }
    roots.retain(|r| r.is_absolute());
    roots
}

/// The prefixes `~/.conda/environments.txt` lists (conda keeps every environment it made
/// there, wherever it is).
fn conda_listed(env: &EnvVars) -> Vec<PathBuf> {
    let Some(home) = home_dir(env).map(PathBuf::from) else {
        return Vec::new();
    };
    let Some(data) =
        crate::exec::read_small_file(&home.join(".conda").join("environments.txt"), 256 * 1024)
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&data)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .take(MAX_PER_PLACE)
        .collect()
}

/// The name conda gives an environment at `prefix`: `base` for a root, else its folder.
fn conda_name(prefix: &Path) -> Option<String> {
    if prefix.join("condabin").is_dir() || prefix.join("envs").is_dir() {
        return Some("base".into());
    }
    prefix.file_name()?.to_str().map(str::to_owned)
}

/// The environments found on this device, without starting anything. `folder`: the
/// working folder from the settings, whose `venv` or `.venv` counts.
pub fn discover(env: &EnvVars, folder: Option<&Path>) -> Vec<Found> {
    let mut found: Vec<Found> = Vec::new();
    let mut push = |name: String, kind: Kind, path: PathBuf| {
        let Some(path) = path.to_str().map(str::to_owned) else {
            return;
        };
        if valid_name(&name) && !found.iter().any(|f| f.path == path) {
            found.push(Found { name, kind, path });
        }
    };

    // conda: each root is `base`, and its `envs` folder holds the others.
    let mut prefixes: Vec<PathBuf> = Vec::new();
    for root in conda_roots(env) {
        if !root.join("conda-meta").is_dir() && !root.join("envs").is_dir() {
            continue;
        }
        if root.join("conda-meta").is_dir() {
            prefixes.push(root.clone());
        }
        prefixes.extend(subdirs(&root.join("envs")).into_iter().map(|(_, p)| p));
    }
    prefixes.extend(conda_listed(env));
    for prefix in prefixes {
        if !prefix.join("conda-meta").is_dir() {
            continue;
        }
        if let (Some(name), Some(python)) = (conda_name(&prefix), python_in(&prefix)) {
            push(name, Kind::Conda, python);
        }
    }

    // pyenv: each version (and each virtualenv pyenv-virtualenv made) by its folder's name.
    let pyenv_root = env_value(env, "PYENV_ROOT")
        .map(PathBuf::from)
        .or_else(|| {
            home_dir(env).map(|h| {
                let h = PathBuf::from(h);
                if cfg!(windows) {
                    h.join(".pyenv").join("pyenv-win")
                } else {
                    h.join(".pyenv")
                }
            })
        })
        .filter(|r| r.is_absolute());
    if let Some(root) = pyenv_root {
        for (name, prefix) in subdirs(&root.join("versions")) {
            if let Some(python) = python_in(&prefix) {
                push(name, Kind::Pyenv, python);
            }
            for (name, prefix) in subdirs(&prefix.join("envs")) {
                if let Some(python) = python_in(&prefix) {
                    push(name, Kind::Pyenv, python);
                }
            }
        }
    }

    // A virtual environment in the working folder, by its folder's name.
    if let Some(folder) = folder {
        for name in [".venv", "venv"] {
            let prefix = folder.join(name);
            if prefix.join("pyvenv.cfg").is_file()
                && let Some(python) = python_in(&prefix)
            {
                push(name.to_owned(), Kind::Venv, python);
            }
        }
    }
    found
}

/// What a name a Run asks for means on this device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolved {
    /// This interpreter.
    Python(String),
    /// Nothing, or more than one thing: the Member is asked.
    Ask,
}

/// Looks up `name`: the Member's answer for it, an environment added by hand under it, then
/// the one found environment of exactly that name.
pub fn resolve(name: &str, settings: &Settings, found: &[Found]) -> Resolved {
    if let Some(path) = settings.names.get(name) {
        return Resolved::Python(path.clone());
    }
    if let Some(added) = settings.environments.iter().find(|e| e.name == name) {
        return Resolved::Python(added.path.clone());
    }
    let mut matching = found.iter().filter(|f| f.name == name);
    match (matching.next(), matching.next()) {
        (Some(one), None) => Resolved::Python(one.path.clone()),
        _ => Resolved::Ask,
    }
}

/// Every name a Run could ask for that runs here without a question: the Member's answers,
/// the environments added by hand, the found ones that are unambiguous.
pub fn known_names(settings: &Settings, found: &[Found]) -> Vec<String> {
    let mut names: Vec<String> = settings.names.keys().cloned().collect();
    names.extend(settings.environments.iter().map(|e| e.name.clone()));
    for f in found {
        if found.iter().filter(|g| g.name == f.name).count() == 1 {
            names.push(f.name.clone());
        }
    }
    names.sort();
    names.dedup();
    names
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A fake environment: `<prefix>/bin/python`, executable, plus the marker files.
    fn make_env(prefix: &Path, markers: &[&str]) -> PathBuf {
        fs::create_dir_all(prefix.join("bin")).unwrap();
        let python = prefix.join("bin/python");
        fs::write(&python, "#!/bin/sh\necho 'Python 3.12.0'\n").unwrap();
        fs::set_permissions(&python, fs::Permissions::from_mode(0o755)).unwrap();
        for marker in markers {
            if marker.ends_with('/') {
                fs::create_dir_all(prefix.join(marker)).unwrap();
            } else {
                fs::write(prefix.join(marker), "").unwrap();
            }
        }
        python
    }

    fn names(found: &[Found]) -> Vec<(String, Kind)> {
        found.iter().map(|f| (f.name.clone(), f.kind)).collect()
    }

    #[test]
    fn names_a_run_may_ask_for() {
        for ok in [
            "analysis",
            "py312",
            ".venv",
            "my env",
            "анализ",
            &"x".repeat(60),
        ] {
            assert!(valid_name(ok), "{ok}");
        }
        for bad in [
            "",
            " lead",
            "trail ",
            "a\nb",
            "tab\t",
            &"x".repeat(61),
            "zw\u{200b}",
        ] {
            assert!(!valid_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn conda_pyenv_and_the_folders_venv_are_found_from_the_file_system() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        // A miniconda with base and two environments, one of them without an interpreter.
        let base = make_env(&h.join("miniconda3"), &["conda-meta/", "condabin/"]);
        let analysis = make_env(&h.join("miniconda3/envs/analysis"), &["conda-meta/"]);
        fs::create_dir_all(h.join("miniconda3/envs/broken/conda-meta")).unwrap();
        // An environment made elsewhere, listed by conda in environments.txt.
        let elsewhere = make_env(&h.join("projects/thesis-env"), &["conda-meta/"]);
        fs::create_dir_all(h.join(".conda")).unwrap();
        fs::write(
            h.join(".conda/environments.txt"),
            format!(
                "{}\n{}\nrelative/path\n\n{}\n",
                h.join("miniconda3").display(),
                elsewhere.parent().unwrap().parent().unwrap().display(),
                h.join("does/not/exist").display()
            ),
        )
        .unwrap();
        // pyenv: a version and a pyenv-virtualenv made from it.
        let pyenv = make_env(&h.join(".pyenv/versions/3.11.9"), &[]);
        let pyenv_venv = make_env(&h.join(".pyenv/versions/3.11.9/envs/lab"), &["pyvenv.cfg"]);
        // The working folder's .venv, and a venv folder that is not a virtual environment.
        let folder = h.join("research");
        let dot_venv = make_env(&folder.join(".venv"), &["pyvenv.cfg"]);
        make_env(&folder.join("venv"), &[]);

        let env: EnvVars = vec![("HOME".into(), h.into())];
        let found = discover(&env, Some(&folder));
        assert_eq!(
            names(&found),
            [
                ("base".to_owned(), Kind::Conda),
                ("analysis".to_owned(), Kind::Conda),
                ("thesis-env".to_owned(), Kind::Conda),
                ("3.11.9".to_owned(), Kind::Pyenv),
                ("lab".to_owned(), Kind::Pyenv),
                (".venv".to_owned(), Kind::Venv),
            ]
        );
        let path = |p: &Path| p.to_str().unwrap().to_owned();
        assert_eq!(
            found.iter().map(|f| f.path.clone()).collect::<Vec<_>>(),
            [
                path(&base),
                path(&analysis),
                path(&elsewhere),
                path(&pyenv),
                path(&pyenv_venv),
                path(&dot_venv)
            ]
        );
        // Without the folder, its .venv is not there; with nothing at all, nothing is found.
        assert_eq!(discover(&env, None).len(), 5);
        let empty = tempfile::tempdir().unwrap();
        assert!(discover(&vec![("HOME".into(), empty.path().into())], None).is_empty());

        // The shell's CONDA_EXE and PYENV_ROOT lead to installations elsewhere.
        let other = tempfile::tempdir().unwrap();
        let o = other.path();
        make_env(&o.join("forge"), &["conda-meta/", "envs/"]);
        make_env(&o.join("forge/envs/qc"), &["conda-meta/"]);
        make_env(&o.join("pyroot/versions/3.13.1"), &[]);
        let env: EnvVars = vec![
            ("HOME".into(), empty.path().into()),
            ("CONDA_EXE".into(), o.join("forge/bin/conda").into()),
            ("PYENV_ROOT".into(), o.join("pyroot").into()),
        ];
        assert_eq!(
            names(&discover(&env, None)),
            [
                ("base".to_owned(), Kind::Conda),
                ("qc".to_owned(), Kind::Conda),
                ("3.13.1".to_owned(), Kind::Pyenv)
            ]
        );
    }

    #[test]
    fn a_name_resolves_to_the_answer_then_by_hand_then_one_found() {
        let found = vec![
            Found {
                name: "analysis".into(),
                kind: Kind::Conda,
                path: "/c/analysis/bin/python".into(),
            },
            Found {
                name: "base".into(),
                kind: Kind::Conda,
                path: "/c/bin/python".into(),
            },
            Found {
                name: "base".into(),
                kind: Kind::Conda,
                path: "/other/bin/python".into(),
            },
        ];
        let mut settings = Settings::default();
        let py = |p: &str| Resolved::Python(p.to_owned());
        // Found once: used. Found twice, or not at all: asked.
        assert_eq!(
            resolve("analysis", &settings, &found),
            py("/c/analysis/bin/python")
        );
        assert_eq!(resolve("base", &settings, &found), Resolved::Ask);
        assert_eq!(resolve("thesis", &settings, &found), Resolved::Ask);
        // Exact names only.
        assert_eq!(resolve("Analysis", &settings, &found), Resolved::Ask);
        assert_eq!(known_names(&settings, &found), ["analysis"]);

        // An environment added by hand under a name comes before a found one.
        settings.environments.push(crate::settings::NamedEnv {
            name: "analysis".into(),
            path: "/mine/bin/python".into(),
            version: "3.12.0".into(),
        });
        assert_eq!(
            resolve("analysis", &settings, &found),
            py("/mine/bin/python")
        );
        // And the Member's answer for a name comes first of all.
        settings
            .names
            .insert("analysis".into(), "/answer/bin/python".into());
        settings.names.insert("base".into(), "/c/bin/python".into());
        assert_eq!(
            resolve("analysis", &settings, &found),
            py("/answer/bin/python")
        );
        assert_eq!(resolve("base", &settings, &found), py("/c/bin/python"));
        assert_eq!(known_names(&settings, &found), ["analysis", "base"]);
    }
}
