//! Updates (docs/specs/release.md, section 11; the plan's M20): what the app knows about them
//! without Tauri types. The check itself is Tauri's updater plugin, in `shell.rs`, compiled
//! only into a build made with the `updater` feature **and** both `INFALL_UPDATE_PUBKEY` and
//! `INFALL_UPDATE_URL` set (build.rs then sets `cfg(infall_updater)`). Any other build has no
//! updater at all and says nothing about updates.
// In a build without the updater most of this is unused, on purpose: it is still compiled and
// tested everywhere.
#![cfg_attr(not(infall_updater), allow(dead_code, unused_imports))]

use std::fs;
use std::path::Path;

use serde_json::{Value, json};

#[path = "update_endpoint.rs"]
mod endpoint;
#[cfg(test)]
use endpoint::endpoint_allowed;
pub use endpoint::is_loopback_http;

/// Whether this build checks for updates.
#[cfg(test)]
pub const ENABLED: bool = cfg!(infall_updater);
/// The feed's public key and address, as they were when the app was built.
pub const PUBKEY: Option<&str> = option_env!("INFALL_UPDATE_PUBKEY");
pub const URL: Option<&str> = option_env!("INFALL_UPDATE_URL");

/// The automatic check runs at most this often (ms): once a day.
pub const CHECK_EVERY_MS: i64 = 24 * 60 * 60 * 1000;
/// In the app's config folder: when the last automatic check was made.
const FILE: &str = "updates.json";

/// Whether the automatic check is due at `now` (unix ms): never made, made a day ago or more,
/// or made "later" than a day from now (a clock that was wrong then).
pub fn check_due(config: &Path, now: i64) -> bool {
    match last_check(config) {
        None => true,
        Some(last) => now.saturating_sub(last) >= CHECK_EVERY_MS || last > now + CHECK_EVERY_MS,
    }
}

fn last_check(config: &Path) -> Option<i64> {
    let text = fs::read_to_string(config.join(FILE)).ok()?;
    serde_json::from_str::<Value>(&text)
        .ok()?
        .get("lastCheck")?
        .as_i64()
        .filter(|t| *t >= 0)
}

/// Notes that the automatic check was made at `now`. A failure to note it only means the
/// next start checks again.
pub fn record_check(config: &Path, now: i64) {
    let _ = fs::create_dir_all(config);
    let tmp = config.join(format!("{FILE}.tmp"));
    let written = fs::write(&tmp, json!({ "lastCheck": now }).to_string())
        .and_then(|()| fs::rename(&tmp, config.join(FILE)));
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

/// The start screen's line once a new version has been downloaded and checked.
pub fn ready_notice(version: &str) -> String {
    format!("Infall {version} is ready — Restart to update")
}

/// A version as the feed may write it, made safe to show: digits, letters, `.`, `-`, `+`,
/// at most 32 characters. `None` if nothing plausible is left.
pub fn shown_version(version: &str) -> Option<String> {
    let v = version.trim().trim_start_matches('v');
    let ok = !v.is_empty()
        && v.len() <= 32
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
    ok.then(|| v.to_owned())
}

/// The updater plugin's configuration (`plugins.updater` in tauri.conf.json, whose `pubkey`
/// and `endpoints` are left empty there), filled in from what the build was given. Plain
/// `http://` is allowed only to this computer, for trying an update against a local feed.
pub fn plugin_config(base: Option<&Value>, pubkey: &str, url: &str) -> Value {
    let mut config = base.cloned().filter(Value::is_object).unwrap_or(json!({}));
    let object = config.as_object_mut().expect("an object");
    object.insert("pubkey".into(), json!(pubkey));
    object.insert("endpoints".into(), json!([url]));
    object.insert(
        "dangerousInsecureTransportProtocol".into(),
        json!(is_loopback_http(url)),
    );
    config
}

/// What the menu's "Check for updates…" says when it is done.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Checked {
    /// A newer version was downloaded and checked.
    Ready(String),
    /// This is the newest.
    UpToDate,
    /// The feed did not answer, or answered something unusable.
    Failed,
}

impl Checked {
    pub fn message(&self, current: &str) -> (&'static str, String) {
        match self {
            Checked::Ready(version) => (
                "An update is ready",
                format!(
                    "Infall {version} has been downloaded. It is installed when you choose \
                     “Restart to update” on the start screen (Switch Workspace…). Your workspaces \
                     are backed up first."
                ),
            ),
            Checked::UpToDate => (
                "Infall is up to date",
                format!("Infall {current} is the newest version."),
            ),
            Checked::Failed => (
                "No update could be checked",
                "Infall could not reach its update server. Check the network and try again later."
                    .to_owned(),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_790_000_000_000;

    #[test]
    fn the_check_is_made_at_most_once_a_day() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        assert!(check_due(&config, NOW));
        record_check(&config, NOW);
        assert!(!check_due(&config, NOW + 1));
        assert!(!check_due(&config, NOW + CHECK_EVERY_MS - 1));
        assert!(check_due(&config, NOW + CHECK_EVERY_MS));
        // A clock set back an hour does not check again; one set back by days does.
        assert!(!check_due(&config, NOW - 3_600_000));
        assert!(check_due(&config, NOW - 2 * CHECK_EVERY_MS));
        // A damaged file: checked again.
        fs::write(config.join(FILE), "not json").unwrap();
        assert!(check_due(&config, NOW));
        fs::write(config.join(FILE), r#"{"lastCheck":-5}"#).unwrap();
        assert!(check_due(&config, NOW));
        assert!(!config.join(format!("{FILE}.tmp")).exists());
    }

    #[test]
    fn the_notice_names_the_version() {
        assert_eq!(
            ready_notice("0.9.1"),
            "Infall 0.9.1 is ready — Restart to update"
        );
        assert_eq!(shown_version("v0.9.1").as_deref(), Some("0.9.1"));
        assert_eq!(
            shown_version(" 1.0.0-rc.1+b7 ").as_deref(),
            Some("1.0.0-rc.1+b7")
        );
        for bad in ["", "v", "1.0 <script>", "1.0\n2", &"9".repeat(33)] {
            assert_eq!(shown_version(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn only_https_or_this_computer_is_a_feed() {
        for good in [
            "https://downloads.example.org/infall/latest.json",
            "https://example.org/{{target}}/{{arch}}/{{current_version}}",
            "http://127.0.0.1:8765/latest.json",
            "http://localhost/latest.json",
            "http://[::1]:9000/latest.json",
        ] {
            assert!(endpoint_allowed(good), "{good}");
        }
        for bad in [
            "http://downloads.example.org/latest.json",
            "http://127.0.0.1.evil.example/latest.json",
            "http://localhost.evil.example/",
            "http://127.0.0.1:x/",
            "https://",
            "https://user@example.org/",
            "ftp://example.org/",
            "https://example.org/a b",
            "",
        ] {
            assert!(!endpoint_allowed(bad), "{bad}");
        }
        assert!(is_loopback_http("http://127.0.0.1:8765/latest.json"));
        assert!(!is_loopback_http("https://127.0.0.1/"));
    }

    #[test]
    fn the_plugin_is_configured_from_what_the_build_was_given() {
        let base =
            json!({ "pubkey": "", "endpoints": [], "windows": { "installMode": "passive" } });
        let config = plugin_config(Some(&base), "KEY", "https://example.org/latest.json");
        assert_eq!(
            config,
            json!({
                "pubkey": "KEY",
                "endpoints": ["https://example.org/latest.json"],
                "dangerousInsecureTransportProtocol": false,
                "windows": { "installMode": "passive" }
            })
        );
        let local = plugin_config(None, "KEY", "http://127.0.0.1:8765/latest.json");
        assert_eq!(local["dangerousInsecureTransportProtocol"], json!(true));
        assert_eq!(
            local["endpoints"],
            json!(["http://127.0.0.1:8765/latest.json"])
        );
    }

    #[test]
    fn todays_builds_have_no_updater() {
        // The updater is there only with the feature and both values; a plain `cargo build`
        // (today's builds) has neither, and the app then says nothing about updates.
        let given = |v: Option<&str>| v.is_some_and(|v| !v.trim().is_empty());
        assert_eq!(
            ENABLED,
            cfg!(feature = "updater") && given(PUBKEY) && given(URL)
        );
        if ENABLED {
            assert!(URL.is_some_and(endpoint_allowed));
        }
    }

    #[test]
    fn the_menu_says_what_the_check_found() {
        let (title, text) = Checked::Ready("0.9.1".into()).message("0.9.0");
        assert_eq!(title, "An update is ready");
        assert!(text.starts_with("Infall 0.9.1 has been downloaded."));
        let (_, text) = Checked::UpToDate.message("0.9.0");
        assert_eq!(text, "Infall 0.9.0 is the newest version.");
        assert!(
            Checked::Failed
                .message("0.9.0")
                .1
                .contains("could not reach")
        );
    }
}
