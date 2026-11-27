//! What the Member chose in the Runner settings window, per device: the default
//! interpreter, optionally the folder Runs execute in, the Python environments added by hand,
//! which environment a name a Run asks for means here, and the Toolchains of other languages
//! (docs/specs/desktop.md, "Languages"; docs/specs/pdf-sources.md, Part 2). `runner.json` in
//! the app's config directory. Only the settings window writes it; a page cannot.
//!
//! Each part is read on its own, and each entry of a list or map too: anything unreadable or
//! implausible counts as not chosen, and the rest of the file still holds.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::envs;
use crate::toolchains;

const FILE: &str = "runner.json";

/// A Python interpreter: where it is and which version it said it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Interpreter {
    pub path: String,
    pub version: String,
}

/// A Python environment the Member added by hand, under a name of their choosing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamedEnv {
    pub name: String,
    pub path: String,
    pub version: String,
}

/// Q#, hosted by the default Python: which distribution was found there when the Member
/// turned it on, and its version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Qsharp {
    /// `qdk`, or `qsharp` for a 1.28 or earlier.
    pub package: String,
    pub version: String,
    /// Turned off by the Member (the switch), keeping what was found.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub off: bool,
}

/// A command Toolchain: what the Runner starts for one language.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Toolchain {
    /// How the language is named (≤ 40 characters).
    pub name: String,
    /// The full path of the program.
    pub program: String,
    /// Its arguments, `{file}` in exactly one of them.
    pub args: Vec<String>,
    /// The extension of the Run's file, without the dot.
    pub ext: String,
    /// What `<program> --version` said when it was saved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Set when, asked its version when it was saved, the program crashed, failed or did
    /// not answer: why, as a short plain sentence. It was set up by hand all the same.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
    /// Turned off by the Member: kept, but no Run is executed with it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub off: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settings {
    /// The default environment's interpreter; `None` until the Member chooses one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub python: Option<Interpreter>,
    /// `None`: a new temporary folder for every Run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    /// Python environments added by hand, by name.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub environments: Vec<NamedEnv>,
    /// A name a Run asks for (`env`) → the interpreter it means on this device. The Member's
    /// answer when a Run first asked for it, or a choice made in the window.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub names: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qsharp: Option<Qsharp>,
    /// Language id → its command Toolchain.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub languages: BTreeMap<String, Toolchain>,
}

fn plausible_path(path: &str) -> bool {
    Path::new(path).is_absolute() && !path.contains('\0')
}

fn part<T: for<'de> Deserialize<'de>>(value: &Value) -> Option<T> {
    serde_json::from_value(value.clone()).ok()
}

/// The saved settings. Anything unreadable or implausible counts as not chosen.
pub fn load(dir: &Path) -> Settings {
    let Ok(text) = fs::read_to_string(dir.join(FILE)) else {
        return Settings::default();
    };
    let Ok(Value::Object(file)) = serde_json::from_str::<Value>(&text) else {
        return Settings::default();
    };
    let get = |key: &str| file.get(key).unwrap_or(&Value::Null);
    let mut settings = Settings {
        python: part::<Interpreter>(get("python")).filter(|p| plausible_path(&p.path)),
        folder: part::<String>(get("folder")).filter(|f| plausible_path(f)),
        ..Settings::default()
    };
    if let Some(list) = get("environments").as_array() {
        for entry in list {
            if let Some(env) = part::<NamedEnv>(entry)
                && envs::valid_name(&env.name)
                && plausible_path(&env.path)
                && !settings.environments.iter().any(|e| e.name == env.name)
                && settings.environments.len() < envs::MAX_ADDED
            {
                settings.environments.push(env);
            }
        }
    }
    if let Some(map) = get("names").as_object() {
        for (name, path) in map {
            if let Some(path) = path.as_str()
                && envs::valid_name(name)
                && plausible_path(path)
                && settings.names.len() < envs::MAX_NAMES
            {
                settings.names.insert(name.clone(), path.to_owned());
            }
        }
    }
    settings.qsharp = part::<Qsharp>(get("qsharp")).filter(|q| {
        matches!(q.package.as_str(), "qdk" | "qsharp") && toolchains::short_plain(&q.version, 40)
    });
    if let Some(map) = get("languages").as_object() {
        for (id, entry) in map {
            if settings.languages.len() == toolchains::MAX_LANGUAGES {
                break;
            }
            if let Some(mut toolchain) = part::<Toolchain>(entry)
                && toolchains::is_command_id(id)
                && toolchains::check_shape(&toolchain).is_ok()
                && toolchain
                    .version
                    .as_deref()
                    .is_none_or(|v| toolchains::short_plain(v, toolchains::MAX_VERSION_CHARS))
            {
                // Only shown: an implausible one is dropped, the language kept.
                toolchain.problem = toolchain
                    .problem
                    .filter(|p| toolchains::short_plain(p, toolchains::MAX_PROBLEM_CHARS));
                settings.languages.insert(id.clone(), toolchain);
            }
        }
    }
    settings
}

/// Saves the settings (written to a temporary file first, then moved into place).
pub fn save(dir: &Path, settings: &Settings) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let text = serde_json::to_string_pretty(settings)?;
    let tmp = dir.join(format!("{FILE}.tmp"));
    fs::write(&tmp, text)?;
    fs::rename(tmp, dir.join(FILE))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `unix`, an absolute path on Unix, as an absolute path on the system the test runs on:
    /// the loader drops a path that is not a full one there.
    fn abs(unix: &str) -> String {
        if cfg!(windows) {
            format!("C:{}", unix.replace('/', "\\"))
        } else {
            unix.to_owned()
        }
    }

    #[test]
    fn nothing_is_chosen_at_first() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()), Settings::default());
        assert_eq!(load(&dir.path().join("missing")), Settings::default());
    }

    fn julia() -> Toolchain {
        Toolchain {
            name: "Julia".into(),
            program: abs("/opt/homebrew/bin/julia"),
            args: vec!["{file}".into()],
            ext: "jl".into(),
            version: Some("julia version 1.11.2".into()),
            problem: None,
            off: false,
        }
    }

    #[test]
    fn saved_and_loaded() {
        let dir = tempfile::tempdir().unwrap();
        let dir = dir.path().join("nested/config");
        let chosen = Settings {
            python: Some(Interpreter {
                path: abs("/opt/homebrew/bin/python3"),
                version: "3.12.3".into(),
            }),
            folder: Some(abs("/Users/me/research")),
            environments: vec![NamedEnv {
                name: "lab".into(),
                path: abs("/Users/me/lab/bin/python"),
                version: "3.11.9".into(),
            }],
            names: [(
                "analysis".to_owned(),
                abs("/Users/me/miniconda3/envs/analysis/bin/python"),
            )]
            .into(),
            qsharp: Some(Qsharp {
                package: "qdk".into(),
                version: "1.34.0".into(),
                off: false,
            }),
            languages: [("julia".to_owned(), julia())].into(),
        };
        save(&dir, &chosen).unwrap();
        assert_eq!(load(&dir), chosen);
        assert!(!dir.join("runner.json.tmp").exists());
        // The file says what the spec says it says.
        let text = fs::read_to_string(dir.join(FILE)).unwrap();
        let json: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            json["qsharp"],
            serde_json::json!({"package": "qdk", "version": "1.34.0"})
        );
        assert_eq!(
            json["languages"]["julia"],
            serde_json::json!({"name": "Julia", "program": abs("/opt/homebrew/bin/julia"),
                "args": ["{file}"], "ext": "jl", "version": "julia version 1.11.2"})
        );

        let only_python = Settings {
            folder: None,
            environments: Vec::new(),
            names: BTreeMap::new(),
            qsharp: None,
            languages: BTreeMap::new(),
            ..chosen.clone()
        };
        save(&dir, &only_python).unwrap();
        assert_eq!(load(&dir), only_python);
        // An M8 file has only these two keys.
        let text = fs::read_to_string(dir.join(FILE)).unwrap();
        assert!(
            !text.contains("languages") && !text.contains("names"),
            "{text}"
        );
        save(&dir, &Settings::default()).unwrap();
        assert_eq!(load(&dir), Settings::default());
    }

    #[test]
    fn a_file_edited_into_something_implausible_is_not_a_choice() {
        let dir = tempfile::tempdir().unwrap();
        for text in [
            "",
            "not json",
            "[]",
            r#"{"python":"python3"}"#,
            r#"{"python":{"path":"python3","version":"3.12.3"}}"#,
            r#"{"python":{"path":"./python3","version":"3.12.3"}}"#,
            r#"{"python":{"path":"","version":""},"folder":"relative/folder"}"#,
            r#"{"environments":"all","names":[1],"qsharp":{"package":"evil","version":"1"},"languages":[]}"#,
            r#"{"qsharp":{"package":"qdk","version":"1\n2"}}"#,
        ] {
            fs::write(dir.path().join(FILE), text).unwrap();
            assert_eq!(load(dir.path()), Settings::default(), "{text}");
        }
        // The good half of a half-good file is kept, entry by entry.
        fs::write(
            dir.path().join(FILE),
            serde_json::json!({
                "python": {"path": "python3", "version": "3"},
                "folder": abs("/data"),
                "environments": [
                    {"name": "ok", "path": abs("/e/bin/python"), "version": "3.12.0"},
                    {"name": "", "path": abs("/e/bin/python"), "version": "3.12.0"},
                    {"name": "rel", "path": "bin/python", "version": "3.12.0"},
                    {"name": "ok", "path": abs("/twice/bin/python"), "version": "3.12.0"},
                    "junk"
                ],
                "names": {"analysis": abs("/a/bin/python"), "bad": "relative", "": abs("/x"), "n": 5},
                "languages": {
                    "julia": {"name": "Julia", "program": abs("/bin/julia"), "args": ["{file}"], "ext": "jl"},
                    "python": {"name": "Not Python", "program": abs("/bin/sh"), "args": ["{file}"], "ext": "py"},
                    "qsharp": {"name": "Q", "program": abs("/bin/sh"), "args": ["{file}"], "ext": "qs"},
                    "Bad Id": {"name": "B", "program": abs("/bin/b"), "args": ["{file}"], "ext": "b"},
                    "nofile": {"name": "N", "program": abs("/bin/n"), "args": ["x"], "ext": "n"},
                    "twice": {"name": "T", "program": abs("/bin/t"), "args": ["{file}", "{file}"], "ext": "t"},
                    "relative": {"name": "R", "program": "bin/r", "args": ["{file}"], "ext": "r"},
                    "badext": {"name": "E", "program": abs("/bin/e"), "args": ["{file}"], "ext": ".e"},
                    "longversion": {"name": "L", "program": abs("/bin/l"), "args": ["{file}"], "ext": "l", "version": "v".repeat(41)},
                    "broken": {"name": "B", "program": abs("/bin/b"), "args": ["{file}"], "ext": "b",
                        "problem": "It crashed (signal 6) when asked its version."},
                    "oddproblem": {"name": "O", "program": abs("/bin/o"), "args": ["{file}"], "ext": "o",
                        "problem": "a\nb"}
                }
            })
            .to_string(),
        )
        .unwrap();
        let loaded = load(dir.path());
        assert_eq!(loaded.python, None);
        assert_eq!(loaded.folder.as_deref(), Some(abs("/data").as_str()));
        assert_eq!(
            loaded
                .environments
                .iter()
                .map(|e| e.path.as_str())
                .collect::<Vec<_>>(),
            [abs("/e/bin/python")]
        );
        assert_eq!(
            loaded.names,
            [("analysis".to_owned(), abs("/a/bin/python"))].into()
        );
        assert_eq!(
            loaded.languages.keys().collect::<Vec<_>>(),
            ["broken", "julia", "oddproblem"],
            "{loaded:?}"
        );
        // A language not working when it was saved is still one; an odd reason is dropped.
        assert_eq!(
            loaded.languages["broken"].problem.as_deref(),
            Some("It crashed (signal 6) when asked its version.")
        );
        assert_eq!(loaded.languages["oddproblem"].problem, None);
    }
}
