//! The one thing the app remembers: the server address, in `config.json` in the app's
//! config directory. No Tauri types.

use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::address::parse_server_address;

const FILE: &str = "config.json";

#[derive(Serialize, Deserialize)]
struct Stored {
    server: String,
}

/// The saved server origin, if there is one and it still passes the address rules.
pub fn load(dir: &Path) -> Option<String> {
    let text = fs::read_to_string(dir.join(FILE)).ok()?;
    let stored: Stored = serde_json::from_str(&text).ok()?;
    parse_server_address(&stored.server).ok()
}

/// Saves the server origin (written to a temporary file first, then moved into place).
pub fn save(dir: &Path, origin: &str) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let text = serde_json::to_string_pretty(&Stored {
        server: origin.to_owned(),
    })?;
    let tmp = dir.join(format!("{FILE}.tmp"));
    fs::write(&tmp, text)?;
    fs::rename(tmp, dir.join(FILE))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_and_loaded() {
        let dir = tempfile::tempdir().unwrap();
        let dir = dir.path().join("nested/config");
        assert_eq!(load(&dir), None);
        save(&dir, "http://localhost:8787").unwrap();
        assert_eq!(load(&dir).as_deref(), Some("http://localhost:8787"));
        save(&dir, "https://qoop.example.org").unwrap();
        assert_eq!(load(&dir).as_deref(), Some("https://qoop.example.org"));
        assert!(!dir.join("config.json.tmp").exists());
    }

    #[test]
    fn a_file_edited_into_something_unacceptable_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        for text in [
            "",
            "not json",
            "{}",
            r#"{"server":"http://evil.example"}"#,
            r#"{"server":"https://user:pw@qoop.example.org"}"#,
            r#"{"server":"file:///etc/passwd"}"#,
        ] {
            fs::write(dir.path().join(FILE), text).unwrap();
            assert_eq!(load(dir.path()), None, "{text}");
        }
    }
}
