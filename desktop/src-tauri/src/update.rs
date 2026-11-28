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
/// The feed of beta builds (one for every change to the code), if the build was given one:
/// only then does the menu offer "Get beta builds".
pub const BETA_URL: Option<&str> = option_env!("INFALL_UPDATE_BETA_URL");
/// Which build of its version this is: a number that grows with every change to the code
/// (the commit's time, `YYYYMMDDHHMM` in UTC). Not given: 0, older than any build of a feed.
pub const BUILD: Option<&str> = option_env!("INFALL_BUILD");

/// The automatic check runs at most this often (ms): once a day.
pub const CHECK_EVERY_MS: i64 = 24 * 60 * 60 * 1000;
/// With beta builds: every five minutes.
pub const BETA_CHECK_EVERY_MS: i64 = 5 * 60 * 1000;
/// In the app's config folder: when the last automatic check was made, and whether beta
/// builds are wanted.
const FILE: &str = "updates.json";

/// How often the automatic check runs (ms).
pub fn check_every(beta: bool) -> i64 {
    if beta {
        BETA_CHECK_EVERY_MS
    } else {
        CHECK_EVERY_MS
    }
}

/// Whether the automatic check is due at `now` (unix ms), made at most every `every` ms:
/// never made, made that long ago or more, or made "later" than that from now (a clock that
/// was wrong then).
pub fn check_due(config: &Path, now: i64, every: i64) -> bool {
    match last_check(config) {
        None => true,
        Some(last) => now.saturating_sub(last) >= every || last > now + every,
    }
}

fn stored(config: &Path) -> Option<Value> {
    let text = fs::read_to_string(config.join(FILE)).ok()?;
    serde_json::from_str::<Value>(&text)
        .ok()
        .filter(Value::is_object)
}

fn last_check(config: &Path) -> Option<i64> {
    stored(config)?
        .get("lastCheck")?
        .as_i64()
        .filter(|t| *t >= 0)
}

/// Whether beta builds are wanted ("Get beta builds" in the menu). Off unless switched on.
pub fn beta(config: &Path) -> bool {
    stored(config)
        .and_then(|v| v.get("beta")?.as_bool())
        .unwrap_or(false)
}

/// The address of the feed to ask: the beta one when beta builds are wanted and this build
/// was given one, otherwise the versions' own.
pub fn feed<'a>(wants_beta: bool, url: &'a str, beta_url: Option<&'a str>) -> &'a str {
    let beta_url = beta_url.map(str::trim).filter(|u| !u.is_empty());
    match beta_url {
        Some(beta_url) if wants_beta => beta_url,
        _ => url.trim(),
    }
}

fn store(config: &Path, value: &Value) {
    let _ = fs::create_dir_all(config);
    let tmp = config.join(format!("{FILE}.tmp"));
    let written =
        fs::write(&tmp, value.to_string()).and_then(|()| fs::rename(&tmp, config.join(FILE)));
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

/// Notes that the automatic check was made at `now`. A failure to note it only means the
/// next start checks again.
pub fn record_check(config: &Path, now: i64) {
    store(config, &json!({ "lastCheck": now, "beta": beta(config) }));
}

/// Switches beta builds on or off. The last check is forgotten: the other feed has not been
/// asked yet.
pub fn set_beta(config: &Path, on: bool) {
    store(config, &json!({ "beta": on }));
}

/// The number in `INFALL_BUILD`; 0 when it was not given or is not a number.
pub fn build_number(text: Option<&str>) -> u64 {
    text.and_then(|t| t.trim().parse().ok()).unwrap_or(0)
}

/// Whether the feed's `remote` is newer than this app (`current`, build `build`): a higher
/// version; or the same version with a build number higher than this app's. The versions'
/// feed names no build, so it only ever offers a higher version; the beta feed names the
/// build of every change.
pub fn offers(current: &semver::Version, build: u64, remote: &semver::Version) -> bool {
    use std::cmp::Ordering;
    match remote.cmp_precedence(current) {
        Ordering::Greater => true,
        Ordering::Less => false,
        Ordering::Equal => remote
            .build
            .as_str()
            .parse::<u64>()
            .is_ok_and(|theirs| theirs > build),
    }
}

/// A version as a sentence names it: `0.9.1`, and a beta build `0.9.1 (build 202611281846)`.
pub fn spoken_version(version: &str) -> String {
    match version.split_once('+') {
        Some((core, build)) if !build.is_empty() => format!("{core} (build {build})"),
        _ => version.to_owned(),
    }
}

/// The start screen's line once a new version has been downloaded and checked.
pub fn ready_notice(version: &str) -> String {
    format!(
        "Infall {} is ready — Restart to update",
        spoken_version(version)
    )
}

/// The question asked when a new version is ready: its title, its text, and its two buttons
/// (install now, or not now).
pub fn ready_question(version: &str) -> (&'static str, String, &'static str, &'static str) {
    (
        "A new version of Infall is ready",
        format!(
            "Infall {} has been downloaded. Restart to update: your workspaces are backed up \
             first, and Infall opens again as the new version.",
            spoken_version(version)
        ),
        RESTART,
        "Later",
    )
}

/// The button that installs the update.
pub const RESTART: &str = "Restart to update";

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
/// `endpoints` is the versions' feed; the check itself names the feed it asks (`feed`).
pub fn plugin_config(
    base: Option<&Value>,
    pubkey: &str,
    url: &str,
    beta_url: Option<&str>,
) -> Value {
    let mut config = base.cloned().filter(Value::is_object).unwrap_or(json!({}));
    let object = config.as_object_mut().expect("an object");
    object.insert("pubkey".into(), json!(pubkey));
    object.insert("endpoints".into(), json!([url]));
    object.insert(
        "dangerousInsecureTransportProtocol".into(),
        json!(is_loopback_http(url) || beta_url.is_some_and(is_loopback_http)),
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
            Checked::Ready(version) => {
                let (title, text, ..) = ready_question(version);
                (title, text)
            }
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
        let day = check_every(false);
        assert_eq!(day, CHECK_EVERY_MS);
        assert!(check_due(&config, NOW, day));
        record_check(&config, NOW);
        assert!(!check_due(&config, NOW + 1, day));
        assert!(!check_due(&config, NOW + CHECK_EVERY_MS - 1, day));
        assert!(check_due(&config, NOW + CHECK_EVERY_MS, day));
        // A clock set back an hour does not check again; one set back by days does.
        assert!(!check_due(&config, NOW - 3_600_000, day));
        assert!(check_due(&config, NOW - 2 * CHECK_EVERY_MS, day));
        // A damaged file: checked again.
        fs::write(config.join(FILE), "not json").unwrap();
        assert!(check_due(&config, NOW, day));
        fs::write(config.join(FILE), r#"{"lastCheck":-5}"#).unwrap();
        assert!(check_due(&config, NOW, day));
        assert!(!config.join(format!("{FILE}.tmp")).exists());
    }

    #[test]
    fn beta_builds_are_off_until_switched_on_and_checked_every_five_minutes() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        assert!(!beta(&config));
        record_check(&config, NOW);
        assert!(!beta(&config));
        // Switching forgets the last check: the other feed is asked at once.
        set_beta(&config, true);
        assert!(beta(&config));
        assert!(check_due(&config, NOW + 1, check_every(true)));
        // A check does not switch it off again.
        record_check(&config, NOW);
        assert!(beta(&config));
        assert!(!check_due(
            &config,
            NOW + BETA_CHECK_EVERY_MS - 1,
            check_every(true)
        ));
        assert!(check_due(
            &config,
            NOW + BETA_CHECK_EVERY_MS,
            check_every(true)
        ));
        set_beta(&config, false);
        assert!(!beta(&config));
        for damaged in ["not json", "[]", r#"{"beta":"yes"}"#] {
            fs::write(config.join(FILE), damaged).unwrap();
            assert!(!beta(&config), "{damaged}");
        }
    }

    #[test]
    fn the_beta_feed_is_asked_only_when_wanted_and_given() {
        let (versions, betas) = ("https://example.org/v.json", "https://example.org/b.json");
        assert_eq!(feed(false, versions, Some(betas)), versions);
        assert_eq!(feed(true, versions, Some(betas)), betas);
        assert_eq!(feed(true, versions, None), versions);
        assert_eq!(feed(true, versions, Some("  ")), versions);
    }

    #[test]
    fn a_higher_version_or_a_later_build_of_the_same_is_newer() {
        let v = |text: &str| semver::Version::parse(text).unwrap();
        let mine = v("0.9.0");
        let build = 202611281846;
        // The versions' feed: a higher version only.
        assert!(offers(&mine, build, &v("0.9.1")));
        assert!(offers(&mine, build, &v("1.0.0-rc.1")));
        assert!(!offers(&mine, build, &v("0.9.0")));
        assert!(!offers(&mine, build, &v("0.8.9")));
        assert!(!offers(&v("1.0.0"), build, &v("1.0.0-rc.1")));
        // The beta feed: also a later build of the same version, never an earlier one.
        assert!(offers(&mine, build, &v("0.9.0+202611281847")));
        assert!(!offers(&mine, build, &v("0.9.0+202611281846")));
        assert!(!offers(&mine, build, &v("0.9.0+202611270000")));
        assert!(offers(&mine, build, &v("0.9.1+202611010000")));
        assert!(!offers(&mine, build, &v("0.8.0+202612010000")));
        assert!(!offers(&mine, build, &v("0.9.0+abc")));
        // A build that was given no number is older than any build of the feed.
        assert_eq!(build_number(None), 0);
        assert_eq!(build_number(Some("x")), 0);
        assert_eq!(build_number(Some(" 202611281846 ")), build);
        assert!(offers(&mine, 0, &v("0.9.0+1")));
    }

    #[test]
    fn the_notice_names_the_version() {
        assert_eq!(
            ready_notice("0.9.1"),
            "Infall 0.9.1 is ready — Restart to update"
        );
        assert_eq!(
            ready_notice("0.9.1+202611281846"),
            "Infall 0.9.1 (build 202611281846) is ready — Restart to update"
        );
        assert_eq!(spoken_version("0.9.1+"), "0.9.1+");
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
        let config = plugin_config(
            Some(&base),
            "KEY",
            "https://example.org/latest.json",
            Some("https://example.org/beta.json"),
        );
        assert_eq!(
            config,
            json!({
                "pubkey": "KEY",
                "endpoints": ["https://example.org/latest.json"],
                "dangerousInsecureTransportProtocol": false,
                "windows": { "installMode": "passive" }
            })
        );
        let local = plugin_config(None, "KEY", "http://127.0.0.1:8765/latest.json", None);
        assert_eq!(local["dangerousInsecureTransportProtocol"], json!(true));
        let local_beta = plugin_config(
            None,
            "KEY",
            "https://example.org/latest.json",
            Some("http://127.0.0.1:8765/beta.json"),
        );
        assert_eq!(
            local_beta["dangerousInsecureTransportProtocol"],
            json!(true)
        );
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
            assert!(BETA_URL.is_none_or(|u| u.trim().is_empty() || endpoint_allowed(u.trim())));
        }
    }

    #[test]
    fn the_menu_says_what_the_check_found() {
        let (title, text) = Checked::Ready("0.9.1".into()).message("0.9.0");
        assert_eq!(title, "A new version of Infall is ready");
        assert!(text.starts_with("Infall 0.9.1 has been downloaded. Restart to update:"));
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
