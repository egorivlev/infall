//! Server configuration, read from the environment (contract §1).

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use crate::secret::SecretKey;

/// Where OpenRouter is unless `INFALL_OPENROUTER_URL` says otherwise.
pub const DEFAULT_OPENROUTER_URL: &str = "https://openrouter.ai/api/v1";
/// How long an AI turn may go without progress from upstream (contract §14).
pub const AI_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
/// Where Crossref is unless `INFALL_CROSSREF_URL` says otherwise (contract §17).
pub const DEFAULT_CROSSREF_URL: &str = "https://api.crossref.org";
/// Where arXiv's export API is unless `INFALL_ARXIV_URL` says otherwise (contract §17).
pub const DEFAULT_ARXIV_URL: &str = "https://export.arxiv.org";
/// How long a Source lookup may take in all (contract §17).
pub const LOOKUP_TIMEOUT: Duration = Duration::from_secs(10);
/// How long arXiv may take to answer, and to send each next part, when the server fetches a
/// PDF from it (M19, api.md §20).
pub const PDF_FETCH_TIMEOUT: Duration = Duration::from_secs(30);
/// `INFALL_MAX_PDF_MB` unless set: the largest PDF the server stores (M19, decision 4).
pub const DEFAULT_MAX_PDF_MB: u64 = 100;

/// The prefix the server's variables have: `INFALL_DB`, `INFALL_ADDR`, …
pub const ENV_PREFIX: &str = "INFALL_";
/// Their prefix before the rename (the 0.9.0 builds before it): `QOOP_DB` for `INFALL_DB`.
/// Still read, after the new name (docs/specs/api.md, "Names before the rename").
pub const OLD_ENV_PREFIX: &str = "QOOP_";

/// The variable `name` (an `INFALL_…` name) from the environment; empty counts as not set.
/// When it is not set and its name before the rename (`QOOP_…`) is, that one is used, and
/// one warning line names the variable to set instead.
pub fn env_var(name: &str) -> Option<String> {
    env_var_in(
        name,
        |n| std::env::var(n).ok(),
        |old, new| tracing::warn!("{old} is read as {new}, its name since the rename: rename it"),
    )
}

/// [`env_var`] with the environment and the warning explicit.
pub fn env_var_in(
    name: &str,
    get: impl Fn(&str) -> Option<String>,
    warn: impl FnOnce(&str, &str),
) -> Option<String> {
    let set = |n: &str| get(n).filter(|v| !v.trim().is_empty());
    if let Some(value) = set(name) {
        return Some(value);
    }
    let old = format!("{OLD_ENV_PREFIX}{}", name.strip_prefix(ENV_PREFIX)?);
    let value = set(&old)?;
    warn(&old, name);
    Some(value)
}

/// Everything the server needs to know about where it runs.
#[derive(Debug, Clone)]
pub struct Config {
    pub addr: SocketAddr,
    pub db: PathBuf,
    /// The origin people use, without a trailing slash, e.g. `https://infall.example.org`.
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
    /// (`INFALL_MAX_IMPORT_MB`, default 8 GiB).
    pub max_import_bytes: u64,
    /// The largest PDF stored, in bytes (`INFALL_MAX_PDF_MB`, default 100 MiB; M19).
    pub max_pdf_bytes: u64,
    /// How long arXiv may take to answer, and to send each next part, when a PDF is fetched
    /// from it. Not read from the environment: always `PDF_FETCH_TIMEOUT`, except in tests.
    pub pdf_fetch_timeout: Duration,
}

/// `INFALL_MAX_IMPORT_MB` unless set: 8 GiB. The body streams to a scratch file on the
/// database's disk and is brought in by SQLite from there, so memory does not grow with the
/// file (a 640 MiB file: under 40 MB resident in the server); what a larger file needs is
/// disk — about three times its size free while it comes in — and time. Eighty PDFs at the
/// 100 MiB limit fit.
pub const DEFAULT_MAX_IMPORT_MB: u64 = 8 * 1024;

impl Config {
    /// Reads `INFALL_*` variables, falling back to the contract's defaults.
    pub fn from_env() -> Result<Config, String> {
        let var = env_var;
        let addr = var("INFALL_ADDR").unwrap_or_else(|| "127.0.0.1:8787".to_string());
        let addr = addr
            .parse()
            .map_err(|_| format!("INFALL_ADDR is not a socket address: {addr:?}"))?;
        let public_origin = normalize_origin(
            &var("INFALL_PUBLIC_ORIGIN").unwrap_or_else(|| "http://localhost:8787".to_string()),
        )
        .ok_or("INFALL_PUBLIC_ORIGIN must start with http:// or https://")?;
        let dev_origin = match var("INFALL_DEV_ORIGIN") {
            Some(o) => Some(
                normalize_origin(&o)
                    .ok_or("INFALL_DEV_ORIGIN must start with http:// or https://")?,
            ),
            None => None,
        };
        let secret_key = match var("INFALL_SECRET_KEY") {
            Some(raw) => Some(SecretKey::from_base64(&raw).map_err(|why| {
                format!(
                    "INFALL_SECRET_KEY {why}; `infall-server gen-secret-key` prints a valid one"
                )
            })?),
            None => None,
        };
        let openrouter_url = normalize_base_url(
            &var("INFALL_OPENROUTER_URL").unwrap_or_else(|| DEFAULT_OPENROUTER_URL.to_string()),
        )
        .ok_or(
            "INFALL_OPENROUTER_URL must be an http:// or https:// URL without a query, fragment or credentials",
        )?;
        let crossref_url = normalize_base_url(
            &var("INFALL_CROSSREF_URL").unwrap_or_else(|| DEFAULT_CROSSREF_URL.to_string()),
        )
        .ok_or(
            "INFALL_CROSSREF_URL must be an http:// or https:// URL without a query, fragment or credentials",
        )?;
        let arxiv_url = normalize_base_url(
            &var("INFALL_ARXIV_URL").unwrap_or_else(|| DEFAULT_ARXIV_URL.to_string()),
        )
        .ok_or(
            "INFALL_ARXIV_URL must be an http:// or https:// URL without a query, fragment or credentials",
        )?;
        let max_import_mb = match var("INFALL_MAX_IMPORT_MB") {
            Some(raw) => raw
                .trim()
                .parse::<u64>()
                .ok()
                .filter(|n| (1..=1024 * 1024).contains(n))
                .ok_or("INFALL_MAX_IMPORT_MB must be a whole number of megabytes, at least 1")?,
            None => DEFAULT_MAX_IMPORT_MB,
        };
        let max_pdf_mb = match var("INFALL_MAX_PDF_MB") {
            Some(raw) => raw
                .trim()
                .parse::<u64>()
                .ok()
                .filter(|n| (1..=1024 * 1024).contains(n))
                .ok_or("INFALL_MAX_PDF_MB must be a whole number of megabytes, at least 1")?,
            None => DEFAULT_MAX_PDF_MB,
        };
        Ok(Config {
            addr,
            db: PathBuf::from(var("INFALL_DB").unwrap_or_else(|| "./infall.db".to_string())),
            public_origin,
            dev_origin,
            web_dir: PathBuf::from(
                var("INFALL_WEB_DIR").unwrap_or_else(|| "./web/dist".to_string()),
            ),
            secret_key,
            openrouter_url,
            ai_idle_timeout: AI_IDLE_TIMEOUT,
            crossref_url,
            arxiv_url,
            lookup_timeout: LOOKUP_TIMEOUT,
            max_import_bytes: max_import_mb * 1024 * 1024,
            max_pdf_bytes: max_pdf_mb * 1024 * 1024,
            pdf_fetch_timeout: PDF_FETCH_TIMEOUT,
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
            max_pdf_bytes: DEFAULT_MAX_PDF_MB * 1024 * 1024,
            pdf_fetch_timeout: PDF_FETCH_TIMEOUT,
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

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |n| {
            pairs
                .iter()
                .find(|(k, _)| *k == n)
                .map(|(_, v)| (*v).to_owned())
        }
    }

    fn no_warning(old: &str, new: &str) {
        panic!("no warning expected, got {old} for {new}");
    }

    #[test]
    fn a_variable_is_read_under_its_name_before_the_rename_with_one_warning() {
        // The new name wins; nothing is said.
        let both = env(&[("INFALL_DB", "/new.db"), ("QOOP_DB", "/old.db")]);
        assert_eq!(
            env_var_in("INFALL_DB", both, no_warning).as_deref(),
            Some("/new.db")
        );
        // Only the old name: used, with one warning naming the new one.
        let mut warned = Vec::new();
        let old = env(&[("QOOP_DB", "/old.db")]);
        let value = env_var_in("INFALL_DB", old, |o, n| warned.push(format!("{o}>{n}")));
        assert_eq!(value.as_deref(), Some("/old.db"));
        assert_eq!(warned, vec!["QOOP_DB>INFALL_DB".to_owned()]);
        // An empty new name counts as not set, and so does an empty old one.
        let fallback = env(&[("INFALL_DB", " "), ("QOOP_DB", "/old.db")]);
        assert_eq!(
            env_var_in("INFALL_DB", fallback, |_, _| {}).as_deref(),
            Some("/old.db")
        );
        let empty = env(&[("INFALL_DB", ""), ("QOOP_DB", "")]);
        assert_eq!(env_var_in("INFALL_DB", empty, no_warning), None);
        // Neither; and a name that is not an INFALL_ one has no old name.
        assert_eq!(env_var_in("INFALL_DB", env(&[]), no_warning), None);
        let other = env(&[("QOOP_HOME", "x")]);
        assert_eq!(env_var_in("HOME", other, no_warning), None);
    }

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
            normalize_origin(" https://Infall.example.org/ ").as_deref(),
            Some("https://infall.example.org")
        );
        assert_eq!(normalize_origin("infall.example.org"), None);
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
