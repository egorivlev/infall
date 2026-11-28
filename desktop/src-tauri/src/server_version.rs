//! A Team server older than this app (docs/specs/desktop.md, "An outdated Team server"): what
//! the app makes of the version the server's health check names, without Tauri types.
//!
//! A Team Workspace's page comes from its server, so the page is as old as the server; the
//! app only adds the bridge. An older page keeps working for as long as the bridge still has
//! what that page calls: then the server is merely outdated, and the app says so once. When
//! the app drops or changes something an older page relies on, [`OLDEST_SERVER`] is raised to
//! the first version whose page does not need it, and older servers are refused with a
//! sentence that says to update them.

use semver::Version;

/// The oldest Team server this app still works with. `None`: every server so far, including
/// the ones from before servers named their version.
///
/// **Raise this in the same change that removes or changes a bridge method** (or anything
/// else an older server's page relies on), to the first server version that does not need it.
pub const OLDEST_SERVER: Option<&str> = None;

/// How a Team server's version stands to this app's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Standing {
    /// As new as the app, or newer (a newer page says itself what an older app lacks).
    Current,
    /// Older than the app, and everything it has still works.
    Outdated,
    /// Older than the oldest server this app works with.
    TooOld,
}

/// The version a health check named, if it is one: at most 32 characters of a semantic
/// version. Anything else counts as no version.
pub fn parse(text: &str) -> Option<Version> {
    let text = text.trim();
    (text.len() <= 32)
        .then(|| Version::parse(text).ok())
        .flatten()
}

/// Where `server` stands to the app (`app`), given the oldest server the app works with.
/// A server that names no version is from before servers did: older than any that does.
/// Build numbers are not compared: a server has none.
pub fn standing(app: &Version, oldest: Option<&Version>, server: Option<&Version>) -> Standing {
    use std::cmp::Ordering::Less;
    match (server, oldest) {
        (None, Some(_)) => Standing::TooOld,
        (None, None) => Standing::Outdated,
        (Some(server), Some(oldest)) if server.cmp_precedence(oldest) == Less => Standing::TooOld,
        (Some(server), _) if server.cmp_precedence(app) == Less => Standing::Outdated,
        (Some(_), _) => Standing::Current,
    }
}

fn runs(server: Option<&Version>) -> String {
    match server {
        Some(version) => format!("runs Infall {version}"),
        None => "runs an older version of Infall".to_owned(),
    }
}

fn plain(version: &Version) -> String {
    format!("{}.{}.{}", version.major, version.minor, version.patch)
        + &(if version.pre.is_empty() {
            String::new()
        } else {
            format!("-{}", version.pre)
        })
}

/// The start screen's sentence when the server is too old: the Workspace is not opened.
pub fn too_old(name: &str, server: Option<&Version>, app: &Version) -> String {
    format!(
        "“{name}” is on a server that {}, which this version of the app ({}) no longer works \
         with. Ask an Admin of that server to update it, then open the workspace again.",
        runs(server),
        plain(app)
    )
}

/// The message shown once over a Workspace whose server is outdated: its title and text.
pub fn outdated(name: &str, server: Option<&Version>, app: &Version) -> (&'static str, String) {
    (
        "This workspace's server is outdated",
        format!(
            "“{name}” is on a server that {}; this app is {}. Everything that server has still \
             works. What is newer in the app appears once an Admin updates the server.",
            runs(server),
            plain(app)
        ),
    )
}

/// What is remembered once the message was shown, so that it is shown again only when the
/// server's version or the app's changes.
pub fn said_key(server: Option<&Version>, app: &Version) -> String {
    format!(
        "{}/{}",
        server.map_or("?".to_owned(), ToString::to_string),
        plain(app)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    #[test]
    fn an_older_server_is_outdated_and_one_below_the_oldest_is_too_old() {
        let app = v("0.9.2");
        // No oldest server set: nothing is ever too old.
        assert_eq!(standing(&app, None, Some(&v("0.9.2"))), Standing::Current);
        assert_eq!(standing(&app, None, Some(&v("0.9.3"))), Standing::Current);
        assert_eq!(standing(&app, None, Some(&v("1.0.0"))), Standing::Current);
        assert_eq!(standing(&app, None, Some(&v("0.9.1"))), Standing::Outdated);
        assert_eq!(
            standing(&app, None, Some(&v("0.9.2-rc.1"))),
            Standing::Outdated
        );
        // A server from before servers named their version.
        assert_eq!(standing(&app, None, None), Standing::Outdated);
        // With an oldest server.
        let oldest = v("0.9.1");
        assert_eq!(
            standing(&app, Some(&oldest), Some(&v("0.9.0"))),
            Standing::TooOld
        );
        assert_eq!(standing(&app, Some(&oldest), None), Standing::TooOld);
        assert_eq!(
            standing(&app, Some(&oldest), Some(&v("0.9.1"))),
            Standing::Outdated
        );
        assert_eq!(
            standing(&app, Some(&oldest), Some(&v("0.9.2"))),
            Standing::Current
        );
    }

    #[test]
    fn a_beta_builds_number_is_not_compared_with_a_server() {
        // The app's build number is not part of its version; a feed's is ignored too.
        let app = v("0.9.2+202611281846");
        assert_eq!(standing(&app, None, Some(&v("0.9.2"))), Standing::Current);
        assert_eq!(said_key(Some(&v("0.9.1")), &app), "0.9.1/0.9.2");
    }

    #[test]
    fn only_a_short_semantic_version_is_a_version() {
        assert_eq!(parse(" 0.9.1 "), Some(v("0.9.1")));
        assert_eq!(parse("1.0.0-rc.1"), Some(v("1.0.0-rc.1")));
        for bad in [
            "",
            "latest",
            "0.9",
            "<script>",
            &format!("1.0.0-{}", "a".repeat(40)),
        ] {
            assert_eq!(parse(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn the_oldest_server_is_a_version_not_newer_than_the_app() {
        let app = v(env!("CARGO_PKG_VERSION"));
        if let Some(oldest) = OLDEST_SERVER {
            let oldest = parse(oldest).expect("OLDEST_SERVER is a version");
            assert_ne!(
                oldest.cmp_precedence(&app),
                std::cmp::Ordering::Greater,
                "a server as new as this app must not be refused"
            );
        }
    }

    #[test]
    fn the_sentences_name_the_workspace_and_both_versions() {
        let app = v("0.9.2");
        assert_eq!(
            too_old("Lab", Some(&v("0.9.0")), &app),
            "“Lab” is on a server that runs Infall 0.9.0, which this version of the app (0.9.2) \
             no longer works with. Ask an Admin of that server to update it, then open the \
             workspace again."
        );
        assert!(too_old("Lab", None, &app).contains("runs an older version of Infall, which"));
        let (title, text) = outdated("Lab", Some(&v("0.9.1")), &app);
        assert_eq!(title, "This workspace's server is outdated");
        assert_eq!(
            text,
            "“Lab” is on a server that runs Infall 0.9.1; this app is 0.9.2. Everything that \
             server has still works. What is newer in the app appears once an Admin updates the \
             server."
        );
        assert_eq!(said_key(None, &app), "?/0.9.2");
    }
}
