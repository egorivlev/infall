//! The server address: what may be typed on the start screen, the health check, the origin
//! of the app's own embedded server, and the rule for where the main window may navigate.
//! No Tauri types.

use std::time::Duration;

use url::Url;

/// Checks what the Member typed and returns the server's origin (`https://infall.example.org`,
/// `http://localhost:8787`): `https`, or `http` only for `localhost` and `127.0.0.1`; no
/// user name or password; nothing after the host but an optional `/`.
pub fn parse_server_address(input: &str) -> Result<String, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("Enter the address of your Infall server.".into());
    }
    if input.chars().any(|c| c.is_control() || c.is_whitespace()) || input.len() > 300 {
        return Err("That does not look like a server address.".into());
    }
    let url = Url::parse(input).map_err(|_| {
        "That does not look like a server address. It starts with https://".to_owned()
    })?;
    let host = url
        .host_str()
        .filter(|h| !h.is_empty())
        .ok_or("That does not look like a server address. It starts with https://")?;
    match url.scheme() {
        "https" => {}
        "http" if host == "localhost" || host == "127.0.0.1" => {}
        "http" => {
            return Err(
                "Use https:// — http:// is only accepted for localhost and 127.0.0.1.".into(),
            );
        }
        _ => return Err("The address must start with https://".into()),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Leave the user name and password out of the address.".into());
    }
    if url.query().is_some() || url.fragment().is_some() || !matches!(url.path(), "" | "/") {
        return Err("Enter only the server's address, without a path.".into());
    }
    Ok(url.origin().ascii_serialization())
}

/// The origin of the app's own embedded server (a Local Workspace), as that server reports
/// it: exactly `http://127.0.0.1:<port>`. Nothing typed by anyone goes through here; this is
/// the one way such an origin becomes the main window's origin besides a checked address.
pub fn embedded_origin(origin: &str) -> Result<String, String> {
    const REFUSED: &str = "The workspace's server gave an address the app does not accept.";
    let url = Url::parse(origin).map_err(|_| REFUSED.to_owned())?;
    let plain = url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some_and(|p| p != 0)
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none();
    let serialized = url.origin().ascii_serialization();
    if plain && serialized == origin {
        Ok(serialized)
    } else {
        Err(REFUSED.into())
    }
}

/// Is `url` a page of the server at `origin` (an origin as [`parse_server_address`] returns)?
pub fn same_origin(url: &Url, origin: &str) -> bool {
    matches!(url.scheme(), "http" | "https") && url.origin().ascii_serialization() == origin
}

/// What to do with a navigation in the main window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Navigation {
    /// The server's own pages (and the empty documents frames start from).
    Allow,
    /// Another site: not shown in the app; opened in the system browser.
    External,
    /// Anything else: refused.
    Block,
}

/// The window shows only the configured origin.
pub fn navigation(url: &Url, origin: &str) -> Navigation {
    match url.scheme() {
        "http" | "https" if same_origin(url, origin) => Navigation::Allow,
        // A `blob:` URL has the origin of the page that made it.
        "blob" if url.origin().ascii_serialization() == origin => Navigation::Allow,
        "about" if matches!(url.as_str(), "about:blank" | "about:srcdoc") => Navigation::Allow,
        "http" | "https" | "mailto" => Navigation::External,
        _ => Navigation::Block,
    }
}

/// May `url` be handed to the system browser?
pub fn may_open_externally(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
}

/// What a server's health check said beyond "ok".
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Health {
    /// The server's version, if it named one that reads as a version (servers before 0.9.2
    /// name none).
    pub version: Option<semver::Version>,
}

/// `GET <origin>/api/health` must answer `{ "ok": true }` (and may name its `version`).
/// Redirects are not followed.
pub fn check_health(origin: &str) -> Result<Health, String> {
    check_health_within(origin, Duration::from_secs(8))
}

fn check_health_within(origin: &str, timeout: Duration) -> Result<Health, String> {
    const NOT_INFALL: &str = "That address answered, but not as an Infall server.";
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .max_redirects(0)
        .http_status_as_error(false)
        .build()
        .into();
    let mut response = agent
        .get(format!("{origin}/api/health"))
        .call()
        .map_err(|_| "No server answered at that address. Check it and try again.".to_owned())?;
    if response.status() != 200 {
        return Err(NOT_INFALL.into());
    }
    let body = response
        .body_mut()
        .with_config()
        .limit(4096)
        .read_to_string()
        .map_err(|_| NOT_INFALL.to_owned())?;
    let answer = serde_json::from_str::<serde_json::Value>(&body).ok();
    let ok = answer
        .as_ref()
        .and_then(|v| v.get("ok").and_then(serde_json::Value::as_bool))
        .unwrap_or(false);
    if !ok {
        return Err(NOT_INFALL.into());
    }
    let version = answer
        .as_ref()
        .and_then(|v| v.get("version")?.as_str())
        .and_then(crate::server_version::parse);
    Ok(Health { version })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn accepted_addresses_become_origins() {
        for (input, origin) in [
            ("https://infall.example.org", "https://infall.example.org"),
            (
                "  https://infall.example.org/  ",
                "https://infall.example.org",
            ),
            (
                "HTTPS://Infall.Example.org:443/",
                "https://infall.example.org",
            ),
            (
                "https://infall.example.org:8443",
                "https://infall.example.org:8443",
            ),
            ("http://localhost:8787", "http://localhost:8787"),
            ("http://127.0.0.1:8787/", "http://127.0.0.1:8787"),
            ("http://localhost", "http://localhost"),
            ("https://localhost:8787", "https://localhost:8787"),
            ("https://192.168.1.20", "https://192.168.1.20"),
        ] {
            assert_eq!(
                parse_server_address(input).as_deref(),
                Ok(origin),
                "{input}"
            );
        }
    }

    #[test]
    fn refused_addresses() {
        for input in [
            "",
            "   ",
            "infall.example.org",
            "localhost:8787",
            "http://infall.example.org",
            "http://192.168.1.20:8787",
            "http://localhost.evil.example",
            "http://127.0.0.1.evil.example",
            "http://[::1]:8787",
            "http://0.0.0.0:8787",
            "https://user@infall.example.org",
            "https://user:pw@infall.example.org",
            "https://:pw@infall.example.org",
            "https://infall.example.org/app",
            "https://infall.example.org/?x=1",
            "https://infall.example.org/#x",
            "https://",
            "ftp://infall.example.org",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "tauri://localhost",
            "https://infall.example.org\n.evil.example",
            "https://infall example.org",
        ] {
            assert!(parse_server_address(input).is_err(), "accepted {input:?}");
        }
    }

    #[test]
    fn only_the_configured_origin_is_shown() {
        let origin = "https://infall.example.org";
        let nav = |u: &str| navigation(&Url::parse(u).unwrap(), origin);
        assert_eq!(nav("https://infall.example.org/"), Navigation::Allow);
        assert_eq!(
            nav("https://infall.example.org/board/1?x=1#y"),
            Navigation::Allow
        );
        assert_eq!(
            nav("https://infall.example.org/visual-frame"),
            Navigation::Allow
        );
        assert_eq!(nav("https://infall.example.org:443/a"), Navigation::Allow);
        assert_eq!(nav("about:blank"), Navigation::Allow);
        assert_eq!(nav("about:srcdoc"), Navigation::Allow);
        assert_eq!(
            nav("blob:https://infall.example.org/1234-abcd"),
            Navigation::Allow
        );

        assert_eq!(nav("http://infall.example.org/"), Navigation::External);
        assert_eq!(
            nav("https://infall.example.org:8443/"),
            Navigation::External
        );
        assert_eq!(
            nav("https://infall.example.org.evil.example/"),
            Navigation::External
        );
        assert_eq!(
            nav("https://evil.example/https://infall.example.org/"),
            Navigation::External
        );
        assert_eq!(
            nav("https://infall.example.org@evil.example/"),
            Navigation::External
        );
        assert_eq!(nav("https://doi.org/10.1000/xyz"), Navigation::External);
        assert_eq!(nav("mailto:someone@example.org"), Navigation::External);

        assert_eq!(nav("blob:https://evil.example/1234"), Navigation::Block);
        assert_eq!(nav("file:///etc/passwd"), Navigation::Block);
        assert_eq!(nav("javascript:alert(1)"), Navigation::Block);
        assert_eq!(nav("data:text/html,<script>1</script>"), Navigation::Block);
        assert_eq!(nav("tauri://localhost/index.html"), Navigation::Block);
        assert_eq!(nav("ipc://localhost/claude_send"), Navigation::Block);
        assert_eq!(nav("about:config"), Navigation::Block);
        assert_eq!(nav("x-apple-something://open"), Navigation::Block);
    }

    #[test]
    fn the_embedded_servers_origin_is_exactly_loopback_with_a_port() {
        assert_eq!(
            embedded_origin("http://127.0.0.1:53124").as_deref(),
            Ok("http://127.0.0.1:53124")
        );
        for refused in [
            "http://127.0.0.1",
            "http://127.0.0.1:0",
            "http://127.0.0.1:53124/",
            "http://127.0.0.1:53124/api",
            "http://127.0.0.1:53124?key=x",
            "https://127.0.0.1:53124",
            "http://localhost:53124",
            "http://127.0.0.2:53124",
            "http://[::1]:53124",
            "http://user@127.0.0.1:53124",
            "http://127.0.0.1.evil.example:53124",
            "https://infall.example.org",
            "",
            "not a url",
        ] {
            assert!(embedded_origin(refused).is_err(), "accepted {refused:?}");
        }
        // Once accepted, the window's rules are the same as for any origin.
        let origin = "http://127.0.0.1:53124";
        let nav = |u: &str| navigation(&Url::parse(u).unwrap(), origin);
        assert_eq!(
            nav("http://127.0.0.1:53124/api/local/enter?key=abc"),
            Navigation::Allow
        );
        assert_eq!(nav("http://127.0.0.1:53124/"), Navigation::Allow);
        assert_eq!(nav("http://127.0.0.1:53125/"), Navigation::External);
        assert_eq!(nav("http://localhost:53124/"), Navigation::External);
    }

    #[test]
    fn same_origin_is_exact() {
        let is = |u: &str, o: &str| same_origin(&Url::parse(u).unwrap(), o);
        assert!(is("http://localhost:8787/x", "http://localhost:8787"));
        assert!(!is("http://localhost:8788/x", "http://localhost:8787"));
        assert!(!is("http://127.0.0.1:8787/x", "http://localhost:8787"));
        assert!(!is("https://localhost:8787/x", "http://localhost:8787"));
        assert!(!is("blob:http://localhost:8787/1", "http://localhost:8787"));
    }

    /// A one-shot HTTP server answering every request with `response`.
    fn serve(response: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut buf = [0u8; 2048];
                let n = stream.read(&mut buf).unwrap_or(0);
                assert!(String::from_utf8_lossy(&buf[..n]).starts_with("GET /api/health "));
                let _ = stream.write_all(response.as_bytes());
            }
        });
        origin
    }

    fn http(status: &str, extra: &str, body: &str) -> &'static str {
        Box::leak(
            format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .into_boxed_str(),
        )
    }

    #[test]
    fn health_check() {
        let timeout = Duration::from_secs(5);
        let ok = serve(http("200 OK", "", r#"{"ok":true}"#));
        assert_eq!(check_health_within(&ok, timeout), Ok(Health::default()));
        // A server since 0.9.2 names its version; one that names nonsense names none.
        let named = serve(http("200 OK", "", r#"{"ok":true,"version":"0.9.2"}"#));
        assert_eq!(
            check_health_within(&named, timeout).unwrap().version,
            Some(semver::Version::new(0, 9, 2))
        );
        for nonsense in [
            http("200 OK", "", r#"{"ok":true,"version":"<b>new</b>"}"#),
            http("200 OK", "", r#"{"ok":true,"version":7}"#),
        ] {
            let origin = serve(nonsense);
            assert_eq!(check_health_within(&origin, timeout), Ok(Health::default()));
        }

        for response in [
            http("200 OK", "", r#"{"ok":false}"#),
            http("200 OK", "", r#"{"ok":"true"}"#),
            http("200 OK", "", "<html>hello</html>"),
            http("200 OK", "", ""),
            http("404 Not Found", "", r#"{"ok":true}"#),
            http("500 Internal Server Error", "", r#"{"ok":true}"#),
        ] {
            let origin = serve(response);
            assert_eq!(
                check_health_within(&origin, timeout),
                Err("That address answered, but not as an Infall server.".into()),
                "{response}"
            );
        }
    }

    #[test]
    fn health_check_does_not_follow_redirects() {
        let target = serve(http("200 OK", "", r#"{"ok":true}"#));
        let location = format!("Location: {target}/api/health\r\n");
        let redirecting = serve(http("302 Found", Box::leak(location.into_boxed_str()), ""));
        assert!(check_health_within(&redirecting, Duration::from_secs(5)).is_err());
    }

    #[test]
    fn health_check_with_nobody_there() {
        // A port that was free a moment ago.
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        assert_eq!(
            check_health_within(&format!("http://127.0.0.1:{port}"), Duration::from_secs(2)),
            Err("No server answered at that address. Check it and try again.".into())
        );
    }
}
