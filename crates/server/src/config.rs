//! Server configuration, read from the environment (contract §1).

use std::net::SocketAddr;
use std::path::PathBuf;

/// Everything the server needs to know about where it runs.
#[derive(Debug, Clone)]
pub struct Config {
    pub addr: SocketAddr,
    pub db: PathBuf,
    /// The origin people use, without a trailing slash, e.g. `https://qoop.example.org`.
    pub public_origin: String,
    /// One extra Origin allowed for local UI development.
    pub dev_origin: Option<String>,
    pub web_dir: PathBuf,
}

impl Config {
    /// Reads `QOOP_*` variables, falling back to the contract's defaults.
    pub fn from_env() -> Result<Config, String> {
        let var = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        let addr = var("QOOP_ADDR").unwrap_or_else(|| "127.0.0.1:8787".to_string());
        let addr = addr
            .parse()
            .map_err(|_| format!("QOOP_ADDR is not a socket address: {addr:?}"))?;
        let public_origin = normalize_origin(
            &var("QOOP_PUBLIC_ORIGIN").unwrap_or_else(|| "http://localhost:8787".to_string()),
        )
        .ok_or("QOOP_PUBLIC_ORIGIN must start with http:// or https://")?;
        let dev_origin = match var("QOOP_DEV_ORIGIN") {
            Some(o) => Some(
                normalize_origin(&o)
                    .ok_or("QOOP_DEV_ORIGIN must start with http:// or https://")?,
            ),
            None => None,
        };
        Ok(Config {
            addr,
            db: PathBuf::from(var("QOOP_DB").unwrap_or_else(|| "./qoop.db".to_string())),
            public_origin,
            dev_origin,
            web_dir: PathBuf::from(var("QOOP_WEB_DIR").unwrap_or_else(|| "./web/dist".to_string())),
        })
    }

    /// A configuration for tests and tools: public origin `http://localhost:8787`.
    pub fn for_tests(web_dir: impl Into<PathBuf>) -> Config {
        Config {
            addr: ([127, 0, 0, 1], 0).into(),
            db: PathBuf::from(":memory:"),
            public_origin: "http://localhost:8787".to_string(),
            dev_origin: None,
            web_dir: web_dir.into(),
        }
    }

    /// Whether the session cookie gets `Secure`.
    pub fn secure_cookies(&self) -> bool {
        self.public_origin.starts_with("https://")
    }

    /// Whether `origin` (the request's `Origin` header) is the public or the dev origin.
    pub fn allows_origin(&self, origin: &str) -> bool {
        let same = |allowed: &str| allowed.eq_ignore_ascii_case(origin);
        same(&self.public_origin) || self.dev_origin.as_deref().is_some_and(same)
    }
}

/// Trims whitespace and trailing slashes; `None` unless it is an http(s) origin.
fn normalize_origin(raw: &str) -> Option<String> {
    let o = raw.trim().trim_end_matches('/');
    let lower = o.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))?;
    if rest.is_empty() || rest.contains('/') {
        return None;
    }
    Some(lower)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_are_normalized_and_compared_exactly() {
        assert_eq!(
            normalize_origin(" https://Qoop.example.org/ ").as_deref(),
            Some("https://qoop.example.org")
        );
        assert_eq!(normalize_origin("qoop.example.org"), None);
        assert_eq!(normalize_origin("https://a.org/path"), None);
        let mut c = Config::for_tests(".");
        c.dev_origin = Some("http://localhost:5173".to_string());
        assert!(c.allows_origin("http://localhost:8787"));
        assert!(c.allows_origin("http://localhost:5173"));
        assert!(!c.allows_origin("http://localhost:8787.evil.org"));
        assert!(!c.allows_origin("null"));
        assert!(!c.secure_cookies());
    }
}
