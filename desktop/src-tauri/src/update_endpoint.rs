// Shared by build.rs (which refuses to build an updater with a feed it would not trust) and
// update.rs. Plain string checks: the build script has no URL parser.

/// Whether `url` may be the update feed built into the app: `https://` to a named host, or
/// `http://` to this computer only (`127.0.0.1`, `localhost`, `[::1]`), to try an update
/// against a feed served on the same machine.
#[allow(dead_code)] // build.rs uses it; the app itself only in its tests
pub fn endpoint_allowed(url: &str) -> bool {
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    match url.strip_prefix("https://") {
        Some(rest) => {
            let host = rest.split(['/', '?', '#']).next().unwrap_or("");
            !host.is_empty() && !host.contains('@')
        }
        None => is_loopback_http(url),
    }
}

/// Whether `url` is plain `http://` to this computer.
pub fn is_loopback_http(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://") else {
        return false;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let name = if host.starts_with('[') {
        host.split_inclusive(']').next().unwrap_or("")
    } else {
        host.split(':').next().unwrap_or("")
    };
    let port_ok = match &host[name.len()..] {
        "" => true,
        port => port
            .strip_prefix(':')
            .is_some_and(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())),
    };
    matches!(name, "127.0.0.1" | "localhost" | "[::1]") && port_ok
}
