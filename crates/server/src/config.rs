//! Server configuration, read from the environment (contract §1).

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use crate::secret::SecretKey;

/// Where OpenRouter is unless `QOOP_OPENROUTER_URL` says otherwise.
pub const DEFAULT_OPENROUTER_URL: &str = "https://openrouter.ai/api/v1";
/// How long an AI turn may go without progress from upstream (contract §14).
pub const AI_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
/// Where Crossref is unless `QOOP_CROSSREF_URL` says otherwise (contract §17).
pub const DEFAULT_CROSSREF_URL: &str = "https://api.crossref.org";
/// Where arXiv's export API is unless `QOOP_ARXIV_URL` says otherwise (contract §17).
pub const DEFAULT_ARXIV_URL: &str = "https://export.arxiv.org";
/// How long a Source lookup may take in all (contract §17).
pub const LOOKUP_TIMEOUT: Duration = Duration::from_secs(10);

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
    /// Seals Members' OpenRouter keys at rest; `None` turns the OpenRouter path off.
    pub secret_key: Option<SecretKey>,
    /// The upstream base URL, without a trailing slash: the only host the server calls.
    pub openrouter_url: String,
    /// How long an AI turn may go without progress from upstream. Not read from the
    /// environment: always `AI_IDLE_TIMEOUT`, except in tests.
    pub ai_idle_timeout: Duration,
    /// Crossref's base URL, without a trailing slash: where DOIs are looked up.
    pub crossref_url: String,
    /// arXiv's export API base URL, without a trailing slash: where arXiv ids are looked up.
    pub arxiv_url: String,
    /// How long a Source lookup may take in all. Not read from the environment: always
    /// `LOOKUP_TIMEOUT`, except in tests.
    pub lookup_timeout: Duration,
    /// The largest Workspace file `POST /api/workspace/import` takes, in bytes
    /// (`QOOP_MAX_IMPORT_MB`, default 512 MiB).
    pub max_import_bytes: u64,
}

/// `QOOP_MAX_IMPORT_MB` unless set.
pub const DEFAULT_MAX_IMPORT_MB: u64 = 512;

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
        let secret_key = match var("QOOP_SECRET_KEY") {
            Some(raw) => Some(SecretKey::from_base64(&raw).map_err(|why| {
                format!("QOOP_SECRET_KEY {why}; `qoop-server gen-secret-key` prints a valid one")
            })?),
            None => None,
        };
        let openrouter_url = normalize_base_url(
            &var("QOOP_OPENROUTER_URL").unwrap_or_else(|| DEFAULT_OPENROUTER_URL.to_string()),
        )
        .ok_or(
            "QOOP_OPENROUTER_URL must be an http:// or https:// URL without a query, fragment or credentials",
        )?;
        let crossref_url = normalize_base_url(
            &var("QOOP_CROSSREF_URL").unwrap_or_else(|| DEFAULT_CROSSREF_URL.to_string()),
        )
        .ok_or(
            "QOOP_CROSSREF_URL must be an http:// or https:// URL without a query, fragment or credentials",
        )?;
        let arxiv_url = normalize_base_url(
            &var("QOOP_ARXIV_URL").unwrap_or_else(|| DEFAULT_ARXIV_URL.to_string()),
        )
        .ok_or(
            "QOOP_ARXIV_URL must be an http:// or https:// URL without a query, fragment or credentials",
        )?;
        let max_import_mb = match var("QOOP_MAX_IMPORT_MB") {
            Some(raw) => raw
                .trim()
                .parse::<u64>()
                .ok()
                .filter(|n| (1..=1024 * 1024).contains(n))
                .ok_or("QOOP_MAX_IMPORT_MB must be a whole number of megabytes, at least 1")?,
            None => DEFAULT_MAX_IMPORT_MB,
        };
        Ok(Config {
            addr,
            db: PathBuf::from(var("QOOP_DB").unwrap_or_else(|| "./qoop.db".to_string())),
            public_origin,
            dev_origin,
            web_dir: PathBuf::from(var("QOOP_WEB_DIR").unwrap_or_else(|| "./web/dist".to_string())),
            secret_key,
            openrouter_url,
            ai_idle_timeout: AI_IDLE_TIMEOUT,
            crossref_url,
            arxiv_url,
            lookup_timeout: LOOKUP_TIMEOUT,
            max_import_bytes: max_import_mb * 1024 * 1024,
        })
    }

    /// A configuration for tests and tools: public origin `http://localhost:8787`, the
    /// OpenRouter path off.
    pub fn for_tests(web_dir: impl Into<PathBuf>) -> Config {
        Config {
            addr: ([127, 0, 0, 1], 0).into(),
            db: PathBuf::from(":memory:"),
            public_origin: "http://localhost:8787".to_string(),
            dev_origin: None,
            web_dir: web_dir.into(),
            secret_key: None,
            openrouter_url: DEFAULT_OPENROUTER_URL.to_string(),
            ai_idle_timeout: AI_IDLE_TIMEOUT,
            crossref_url: DEFAULT_CROSSREF_URL.to_string(),
            arxiv_url: DEFAULT_ARXIV_URL.to_string(),
            lookup_timeout: LOOKUP_TIMEOUT,
            max_import_bytes: DEFAULT_MAX_IMPORT_MB * 1024 * 1024,
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

/// Trims whitespace and trailing slashes; `None` unless it is an http(s) URL with a host
/// and without a query, a fragment or credentials.
pub fn normalize_base_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    let url = reqwest::Url::parse(trimmed).ok()?;
    let plain = matches!(url.scheme(), "http" | "https")
        && url.has_host()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none();
    plain.then(|| trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_upstream_base_url_is_a_plain_http_url() {
        assert_eq!(
            normalize_base_url(" https://openrouter.ai/api/v1/ ").as_deref(),
            Some("https://openrouter.ai/api/v1")
        );
        assert_eq!(
            normalize_base_url("http://127.0.0.1:9000").as_deref(),
            Some("http://127.0.0.1:9000")
        );
        for bad in [
            "openrouter.ai/api/v1",
            "ftp://openrouter.ai",
            "https://user:pw@openrouter.ai/api/v1",
            "https://openrouter.ai/api/v1?x=1",
            "https://openrouter.ai/api/v1#frag",
            "file:///etc/passwd",
            "",
        ] {
            assert_eq!(normalize_base_url(bad), None, "{bad}");
        }
    }

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
