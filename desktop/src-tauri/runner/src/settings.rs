//! What the Member chose in the Runner settings window, per device: the interpreter and,
//! optionally, the folder Runs execute in. `runner.json` in the app's config directory.
//! Only the settings window writes it; a page cannot.

use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

const FILE: &str = "runner.json";

/// A Python interpreter: where it is and which version it said it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Interpreter {
    pub path: String,
    pub version: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settings {
    /// `None` until the Member chooses one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub python: Option<Interpreter>,
    /// `None`: a new temporary folder for every Run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
}

/// The saved settings. Anything unreadable or implausible counts as not chosen.
pub fn load(dir: &Path) -> Settings {
    let Ok(text) = fs::read_to_string(dir.join(FILE)) else {
        return Settings::default();
    };
    let mut settings: Settings = serde_json::from_str(&text).unwrap_or_default();
    let plausible = |path: &str| Path::new(path).is_absolute() && !path.contains('\0');
    if settings
        .python
        .as_ref()
        .is_some_and(|p| !plausible(&p.path))
    {
        settings.python = None;
    }
    if settings.folder.as_deref().is_some_and(|f| !plausible(f)) {
        settings.folder = None;
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

    #[test]
    fn nothing_is_chosen_at_first() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()), Settings::default());
        assert_eq!(load(&dir.path().join("missing")), Settings::default());
    }

    #[test]
    fn saved_and_loaded() {
        let dir = tempfile::tempdir().unwrap();
        let dir = dir.path().join("nested/config");
        let chosen = Settings {
            python: Some(Interpreter {
                path: "/opt/homebrew/bin/python3".into(),
                version: "3.12.3".into(),
            }),
            folder: Some("/Users/me/research".into()),
        };
        save(&dir, &chosen).unwrap();
        assert_eq!(load(&dir), chosen);
        assert!(!dir.join("runner.json.tmp").exists());

        let only_python = Settings {
            folder: None,
            ..chosen.clone()
        };
        save(&dir, &only_python).unwrap();
        assert_eq!(load(&dir), only_python);
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
        ] {
            fs::write(dir.path().join(FILE), text).unwrap();
            assert_eq!(load(dir.path()), Settings::default(), "{text}");
        }
        // The good half of a half-good file is kept.
        fs::write(
            dir.path().join(FILE),
            r#"{"python":{"path":"python3","version":"3"},"folder":"/data"}"#,
        )
        .unwrap();
        assert_eq!(
            load(dir.path()),
            Settings {
                python: None,
                folder: Some("/data".into())
            }
        );
    }
}
