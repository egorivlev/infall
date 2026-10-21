//! Sources that fill themselves in (contract §17): `POST /api/sources/lookup` asks Crossref
//! for a DOI or arXiv for an arXiv id, and answers with the title, authors and year in the
//! form a Source keeps them. Nothing is stored; the web UI fills its form with the answer.
//!
//! The server calls out only when a Member asks, only to the two configured base addresses,
//! and sends nothing but the id: no cookie, no name, nothing about the Workspace.

use axum::Json;
use axum::extract::State;
use serde::Serialize;
use serde_json::Value;

use crate::app::Shared;
use crate::auth::MemberOrAdmin;
use crate::error::{ApiError, ApiJson};

/// The most lookups one Member may ask for within a minute.
pub const LOOKUPS_PER_MINUTE: usize = 30;
/// The most bytes of a registry's answer that are read.
const MAX_ANSWER_BYTES: usize = 2 * 1024 * 1024;
/// The longest DOI taken.
const MAX_DOI_CHARS: usize = 300;
/// Authors past this many are left out and the list ends in "et al.".
pub const MAX_AUTHORS: usize = 100;
/// The longest title or name kept, in characters.
const MAX_TEXT_CHARS: usize = 2000;

const BAD_INPUT: &str = "Send either { \"doi\": \"10.…\" } or { \"arxiv\": \"2103.05577\" }.";
const NOT_A_DOI: &str =
    "That is not a DOI. A DOI starts with 10. and has a slash, like 10.1038/nature12373.";
const NOT_AN_ARXIV_ID: &str =
    "That is not an arXiv id. It looks like 2103.05577, or hep-th/9711200 for older papers.";

const CROSSREF_UNKNOWN: &str = "Crossref has no record of this DOI. It may be registered elsewhere (for example with DataCite); fill in the fields by hand.";
const CROSSREF_DOWN: &str = "Crossref could not be reached. Check the internet connection and try again, or fill in the fields by hand.";
const CROSSREF_BUSY: &str =
    "Crossref is not answering right now. Try again later, or fill in the fields by hand.";
const CROSSREF_SLOW: &str =
    "Crossref did not answer within 10 seconds. Try again, or fill in the fields by hand.";
const CROSSREF_NONSENSE: &str = "Crossref sent an answer Infall could not read. Try again later, or fill in the fields by hand.";

const ARXIV_UNKNOWN: &str =
    "arXiv has no paper with this id. Check the id, or fill in the fields by hand.";
const ARXIV_DOWN: &str = "arXiv could not be reached. Check the internet connection and try again, or fill in the fields by hand.";
const ARXIV_BUSY: &str =
    "arXiv is not answering right now. Try again later, or fill in the fields by hand.";
const ARXIV_SLOW: &str =
    "arXiv did not answer within 10 seconds. Try again, or fill in the fields by hand.";
const ARXIV_NONSENSE: &str =
    "arXiv sent an answer Infall could not read. Try again later, or fill in the fields by hand.";

/// What a lookup found; this is also its JSON shape. Fields the registry lacks are `""`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Found {
    pub title: String,
    /// Names as "Given Family", joined by ", ", the way a Source's `authors` is written.
    pub authors: String,
    pub year: String,
    pub doi: Option<String>,
    pub url: Option<String>,
}

/// What is asked for, already checked and in its plain form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Wanted {
    Doi(String),
    Arxiv(String),
}

/// Reads the body: exactly one of `doi` and `arxiv`, a string that is one.
pub fn wanted(body: &Value) -> Result<Wanted, ApiError> {
    let bad = || ApiError::BadRequest(BAD_INPUT.to_string());
    let obj = body.as_object().ok_or_else(bad)?;
    match (obj.get("doi"), obj.get("arxiv")) {
        (Some(doi), None) => {
            let raw = doi.as_str().ok_or_else(bad)?;
            clean_doi(raw)
                .map(Wanted::Doi)
                .ok_or_else(|| ApiError::BadRequest(NOT_A_DOI.to_string()))
        }
        (None, Some(id)) => {
            let raw = id.as_str().ok_or_else(bad)?;
            clean_arxiv(raw)
                .map(Wanted::Arxiv)
                .ok_or_else(|| ApiError::BadRequest(NOT_AN_ARXIV_ID.to_string()))
        }
        _ => Err(bad()),
    }
}

/// A DOI as given, or written as `doi:…` or a `doi.org` address; `None` unless it is
/// `10.<4–9 digits>/<something>` without spaces.
pub fn clean_doi(raw: &str) -> Option<String> {
    let s = raw.trim();
    let lower = s.to_ascii_lowercase();
    let mut rest = s;
    for prefix in [
        "https://doi.org/",
        "http://doi.org/",
        "https://dx.doi.org/",
        "http://dx.doi.org/",
        "doi.org/",
        "doi:",
    ] {
        if lower.starts_with(prefix) {
            rest = s[prefix.len()..].trim_start();
            break;
        }
    }
    let (prefix, suffix) = rest.split_once('/')?;
    let registrant = prefix.strip_prefix("10.")?;
    let ok = (4..=9).contains(&registrant.len())
        && registrant.bytes().all(|b| b.is_ascii_digit())
        && !suffix.is_empty()
        && rest.chars().count() <= MAX_DOI_CHARS
        && !rest.chars().any(|c| c.is_whitespace() || c.is_control());
    ok.then(|| rest.to_string())
}

/// An arXiv id as given, or written as `arXiv:…` or an `arxiv.org` address under `/abs/`,
/// `/pdf/` or `/html/`; `None` unless it is a new (`2103.05577`, `2103.05577v2`) or an old
/// (`hep-th/9711200`, `math.GT/0309136`) id.
pub fn clean_arxiv(raw: &str) -> Option<String> {
    let s = raw.trim();
    let lower = s.to_ascii_lowercase();
    let mut rest = s;
    if lower.starts_with("arxiv:") {
        rest = &s["arxiv:".len()..];
    } else {
        for host in ["arxiv.org/", "www.arxiv.org/", "export.arxiv.org/"] {
            for scheme in ["https://", "http://", ""] {
                let start = format!("{scheme}{host}");
                if !lower.starts_with(&start) {
                    continue;
                }
                let path = &s[start.len()..];
                let path_lower = path.to_ascii_lowercase();
                let id = ["abs/", "pdf/", "html/"]
                    .iter()
                    .find(|p| path_lower.starts_with(**p))
                    .map(|p| &path[p.len()..])?;
                let id = id.split(['?', '#']).next().unwrap_or("");
                let id = id.trim_end_matches('/');
                rest = id.strip_suffix(".pdf").unwrap_or(id);
                return arxiv_id_ok(rest).then(|| rest.to_string());
            }
        }
    }
    let rest = rest.trim();
    arxiv_id_ok(rest).then(|| rest.to_string())
}

fn arxiv_id_ok(id: &str) -> bool {
    let (base, version) = match id.rfind('v') {
        Some(i) if i > 0 && id[i + 1..].bytes().all(|b| b.is_ascii_digit()) && i + 1 < id.len() => {
            (&id[..i], Some(&id[i + 1..]))
        }
        _ => (id, None),
    };
    if version.is_some_and(|v| v.len() > 3) {
        return false;
    }
    let digits =
        |s: &str, lens: &[usize]| lens.contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit());
    if let Some((yymm, num)) = base.split_once('.')
        && digits(yymm, &[4])
        && digits(num, &[4, 5])
    {
        return true;
    }
    // Old style: archive, optional subject class, a slash, seven digits.
    let Some((archive, num)) = base.split_once('/') else {
        return false;
    };
    let (name, class) = match archive.split_once('.') {
        Some((n, c)) => (n, Some(c)),
        None => (archive, None),
    };
    !name.is_empty()
        && name.len() <= 20
        && name.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
        && class.is_none_or(|c| {
            (1..=4).contains(&c.len()) && c.bytes().all(|b| b.is_ascii_alphabetic())
        })
        && digits(num, &[7])
}

/// `POST /api/sources/lookup`.
pub async fn lookup(
    State(st): State<Shared>,
    MemberOrAdmin(who): MemberOrAdmin,
    ApiJson(body): ApiJson<Value>,
) -> Result<Json<Found>, ApiError> {
    let wanted = wanted(&body)?;
    if !st.lookup_rate.allow(who.id().0, st.clock.now()) {
        return Err(ApiError::TooManyLookups);
    }
    let found = match wanted {
        Wanted::Doi(doi) => crossref(&st, &doi).await?,
        Wanted::Arxiv(id) => arxiv(&st, &id).await?,
    };
    Ok(Json(found))
}

/// Why a registry gave nothing usable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Fault {
    Unknown,
    /// No connection could be made.
    Down,
    /// It answered with an error status.
    Busy,
    Slow,
    Nonsense,
}

impl Fault {
    fn error(self, crossref: bool) -> ApiError {
        let pick = |c: &'static str, a: &'static str| if crossref { c } else { a };
        match self {
            Fault::Unknown => ApiError::LookupNotFound(pick(CROSSREF_UNKNOWN, ARXIV_UNKNOWN)),
            Fault::Down => ApiError::LookupFailed(pick(CROSSREF_DOWN, ARXIV_DOWN)),
            Fault::Busy => ApiError::LookupFailed(pick(CROSSREF_BUSY, ARXIV_BUSY)),
            Fault::Slow => ApiError::LookupFailed(pick(CROSSREF_SLOW, ARXIV_SLOW)),
            Fault::Nonsense => ApiError::LookupFailed(pick(CROSSREF_NONSENSE, ARXIV_NONSENSE)),
        }
    }
}

/// Fetches `url` within the lookup time limit. `404` is `Unknown`; any other status that is
/// not a success is `Busy`. The answer is never logged.
async fn fetch(st: &Shared, url: &str, accept: &str, registry: &str) -> Result<Vec<u8>, Fault> {
    let get = async {
        let mut res = st
            .ai
            .http
            .get(url)
            .header(reqwest::header::ACCEPT, accept)
            .send()
            .await
            .map_err(|e| {
                tracing::warn!(registry, timeout = e.is_timeout(), "lookup: no answer");
                Fault::Down
            })?;
        let status = res.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(Fault::Unknown);
        }
        if !status.is_success() {
            tracing::warn!(registry, status = status.as_u16(), "lookup refused");
            return Err(Fault::Busy);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = res.chunk().await.map_err(|_| Fault::Down)? {
            if bytes.len() + chunk.len() > MAX_ANSWER_BYTES {
                tracing::warn!(registry, "lookup answer too large");
                return Err(Fault::Nonsense);
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    };
    match tokio::time::timeout(st.config.lookup_timeout, get).await {
        Ok(result) => result,
        Err(_) => {
            tracing::warn!(registry, "lookup timed out");
            Err(Fault::Slow)
        }
    }
}

// ---------------------------------------------------------------- Crossref

/// Percent-encodes everything in a DOI but unreserved characters and `/`.
fn encode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'/') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

async fn crossref(st: &Shared, doi: &str) -> Result<Found, ApiError> {
    let url = format!("{}/works/{}", st.config.crossref_url, encode_path(doi));
    let bytes = fetch(st, &url, "application/json", "crossref")
        .await
        .map_err(|f| f.error(true))?;
    parse_crossref(&bytes, doi).map_err(|f| f.error(true))
}

/// Reads Crossref's `{ "message": { title, author, issued, DOI } }`.
fn parse_crossref(bytes: &[u8], asked: &str) -> Result<Found, Fault> {
    let body: Value = serde_json::from_slice(bytes).map_err(|_| Fault::Nonsense)?;
    let msg = body
        .get("message")
        .filter(|m| m.is_object())
        .ok_or(Fault::Nonsense)?;
    let title = match msg.get("title") {
        Some(Value::Array(list)) => list.iter().find_map(Value::as_str).unwrap_or(""),
        Some(Value::String(s)) => s.as_str(),
        _ => "",
    };
    let names: Vec<String> = msg
        .get("author")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|a| {
                    let part = |k: &str| a.get(k).and_then(Value::as_str).map(plain_text);
                    let given = part("given").unwrap_or_default();
                    let family = part("family").unwrap_or_default();
                    let name = format!("{given} {family}").trim().to_string();
                    let name = if name.is_empty() {
                        part("name").unwrap_or_default()
                    } else {
                        name
                    };
                    (!name.is_empty()).then_some(name)
                })
                .collect()
        })
        .unwrap_or_default();
    let year = [
        "issued",
        "published",
        "published-print",
        "published-online",
        "created",
    ]
    .iter()
    .find_map(|k| crossref_year(msg.get(*k)?))
    .unwrap_or_default();
    let doi = msg
        .get("DOI")
        .and_then(Value::as_str)
        .and_then(clean_doi)
        .unwrap_or_else(|| asked.to_string());
    Ok(Found {
        title: plain_text(title),
        authors: join_authors(names),
        year,
        doi: Some(doi),
        url: None,
    })
}

/// The year of a Crossref date: `{ "date-parts": [[2021, 3, 9]] }`.
fn crossref_year(date: &Value) -> Option<String> {
    let y = date.get("date-parts")?.get(0)?.get(0)?;
    let y = y.as_i64().or_else(|| y.as_str()?.trim().parse().ok())?;
    (1..=9999).contains(&y).then(|| y.to_string())
}

fn join_authors(mut names: Vec<String>) -> String {
    let more = names.len() > MAX_AUTHORS;
    names.truncate(MAX_AUTHORS);
    let mut out = names.join(", ");
    if more {
        out.push_str(", et al.");
    }
    out
}

/// Text without markup: tags (`<i>`, `<sub>`, MathML) dropped, HTML entities turned into
/// the characters they stand for, control characters dropped, white space collapsed.
pub fn plain_text(raw: &str) -> String {
    let once = decode_entities(&strip_tags(raw));
    // An answer may carry escaped markup (`&lt;i&gt;`); once decoded it is dropped too.
    let text = strip_tags(&once);
    let mut out = String::with_capacity(text.len());
    for word in text.split(|c: char| c.is_whitespace() || c.is_control()) {
        if word.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    out.chars().take(MAX_TEXT_CHARS).collect()
}

/// Drops everything from a `<` that opens a tag (a letter, `/`, `!` or `?` follows) to the
/// next `>`. Inline tags (`<i>`, `<sub>`, MathML) are not word breaks, so `H<sub>2</sub>O`
/// stays one word; `<br>`, `<p>` and the like become a space. A `<` that opens nothing, as
/// in "x < y", stays.
fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        let opens = after
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || matches!(c, '/' | '!' | '?'));
        match after.find('>') {
            Some(end) if opens => {
                let name: String = after[..end]
                    .trim_start_matches('/')
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == ':')
                    .collect::<String>()
                    .to_ascii_lowercase();
                let name = name.rsplit(':').next().unwrap_or("");
                if matches!(name, "br" | "p" | "div" | "li" | "title" | "subtitle") {
                    out.push(' ');
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push('<');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Turns `&amp;`, `&#233;`, `&#xE9;` and the common named entities into characters;
/// an entity it does not know stays as written.
fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        let decoded = after.find(';').filter(|&end| end <= 10).and_then(|end| {
            let name = &after[..end];
            let ch = if let Some(hex) = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X"))
            {
                u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
            } else if let Some(dec) = name.strip_prefix('#') {
                dec.parse::<u32>().ok().and_then(char::from_u32)
            } else {
                named_entity(name)
            };
            ch.map(|c| (c, end))
        });
        match decoded {
            Some((c, end)) => {
                out.push(c);
                rest = &after[end + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn named_entity(name: &str) -> Option<char> {
    Some(match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => ' ',
        "ndash" => '–',
        "mdash" => '—',
        "hellip" => '…',
        "lsquo" => '‘',
        "rsquo" => '’',
        "ldquo" => '“',
        "rdquo" => '”',
        "laquo" => '«',
        "raquo" => '»',
        "middot" => '·',
        "times" => '×',
        "minus" => '−',
        "plusmn" => '±',
        "deg" => '°',
        "alpha" => 'α',
        "beta" => 'β',
        "gamma" => 'γ',
        "delta" => 'δ',
        "epsilon" => 'ε',
        "lambda" => 'λ',
        "mu" => 'μ',
        "pi" => 'π',
        "sigma" => 'σ',
        "omega" => 'ω',
        "auml" => 'ä',
        "ouml" => 'ö',
        "uuml" => 'ü',
        "Auml" => 'Ä',
        "Ouml" => 'Ö',
        "Uuml" => 'Ü',
        "szlig" => 'ß',
        "eacute" => 'é',
        "egrave" => 'è',
        "aacute" => 'á',
        "agrave" => 'à',
        "iacute" => 'í',
        "oacute" => 'ó',
        "uacute" => 'ú',
        "ccedil" => 'ç',
        "ntilde" => 'ñ',
        "Eacute" => 'É',
        _ => return None,
    })
}

// ---------------------------------------------------------------- arXiv

async fn arxiv(st: &Shared, id: &str) -> Result<Found, ApiError> {
    let url = format!(
        "{}/api/query?id_list={}&max_results=1",
        st.config.arxiv_url,
        encode_path(id)
    );
    let bytes = fetch(st, &url, "application/atom+xml", "arxiv")
        .await
        .map_err(|f| f.error(false))?;
    parse_arxiv(&bytes, id).map_err(|f| f.error(false))
}

/// Reads arXiv's Atom feed: the first `<entry>`'s title, authors, published date and DOI.
/// No entry, an entry that is arXiv's error report, or one without a title: not known.
fn parse_arxiv(bytes: &[u8], asked: &str) -> Result<Found, Fault> {
    let text = std::str::from_utf8(bytes).map_err(|_| Fault::Nonsense)?;
    if !text.contains("<feed") {
        return Err(Fault::Nonsense);
    }
    let Some(entry) = element(text, "entry") else {
        return Err(Fault::Unknown);
    };
    if element(entry, "id").is_some_and(|id| id.contains("/api/errors")) {
        return Err(Fault::Unknown);
    }
    let title = element(entry, "title").map(xml_text).unwrap_or_default();
    if title.is_empty() {
        return Err(Fault::Unknown);
    }
    let mut names = Vec::new();
    let mut rest = entry;
    while let Some((author, after)) = element_rest(rest, "author") {
        if let Some(name) = element(author, "name").map(xml_text)
            && !name.is_empty()
        {
            names.push(name);
        }
        rest = after;
    }
    let year = element(entry, "published")
        .map(str::trim)
        .and_then(|d| d.get(..4))
        .filter(|y| y.bytes().all(|b| b.is_ascii_digit()))
        .unwrap_or("")
        .to_string();
    let doi = element(entry, "arxiv:doi")
        .map(xml_text)
        .and_then(|d| clean_doi(&d));
    Ok(Found {
        title,
        authors: join_authors(names),
        year,
        doi,
        url: Some(format!("https://arxiv.org/abs/{asked}")),
    })
}

/// The text inside the first `<name …>…</name>` of `s`.
fn element<'a>(s: &'a str, name: &str) -> Option<&'a str> {
    element_rest(s, name).map(|(inner, _)| inner)
}

/// The text inside the first `<name …>…</name>` of `s`, and what follows it.
fn element_rest<'a>(s: &'a str, name: &str) -> Option<(&'a str, &'a str)> {
    let open = format!("<{name}");
    let close = format!("</{name}>");
    let mut from = 0;
    loop {
        let start = from + s[from..].find(&open)?;
        let after_name = &s[start + open.len()..];
        // `<entry>` but not `<entryfoo>`.
        match after_name.chars().next() {
            Some('>') | Some(' ') | Some('\n') | Some('\t') | Some('\r') | Some('/') => {}
            _ => {
                from = start + open.len();
                continue;
            }
        }
        let tag_end = after_name.find('>')?;
        if after_name[..tag_end].ends_with('/') {
            return Some(("", &after_name[tag_end + 1..]));
        }
        let body = &after_name[tag_end + 1..];
        let end = body.find(&close)?;
        return Some((&body[..end], &body[end + close.len()..]));
    }
}

/// XML text content as plain text: CDATA kept, entities decoded, white space collapsed.
fn xml_text(s: &str) -> String {
    let s = s.trim();
    let s = s
        .strip_prefix("<![CDATA[")
        .and_then(|x| x.strip_suffix("]]>"))
        .map(str::to_string)
        .unwrap_or_else(|| decode_entities(s));
    plain_words(&s)
}

/// White space collapsed, control characters dropped, at most `MAX_TEXT_CHARS`.
fn plain_words(s: &str) -> String {
    s.split(|c: char| c.is_whitespace() || c.is_control())
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_TEXT_CHARS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dois_are_recognised_in_their_usual_spellings() {
        for (raw, want) in [
            ("10.1038/nature12373", "10.1038/nature12373"),
            (
                "  doi:10.1103/PhysRevLett.35.1792 ",
                "10.1103/PhysRevLett.35.1792",
            ),
            ("https://doi.org/10.1007/BF01458701", "10.1007/BF01458701"),
            (
                "HTTP://DX.DOI.ORG/10.1145/1273445.1273458",
                "10.1145/1273445.1273458",
            ),
            (
                "10.1002/(SICI)1097-0258(19980815/30)17:15/16<1661::AID-SIM968>3.0.CO;2-2",
                "10.1002/(SICI)1097-0258(19980815/30)17:15/16<1661::AID-SIM968>3.0.CO;2-2",
            ),
        ] {
            assert_eq!(clean_doi(raw).as_deref(), Some(want), "{raw}");
        }
        for bad in [
            "",
            "10.1038",
            "10.1038/",
            "11.1038/x",
            "10.12/x",
            "10.1038/a b",
            "nature12373",
            "10.abcd/x",
            "https://example.org/10.1038/x",
        ] {
            assert_eq!(clean_doi(bad), None, "{bad}");
        }
        assert_eq!(clean_doi(&format!("10.1038/{}", "x".repeat(400))), None);
    }

    #[test]
    fn arxiv_ids_are_recognised_new_and_old() {
        for (raw, want) in [
            ("2103.05577", "2103.05577"),
            ("arXiv:2007.14384v2", "2007.14384v2"),
            ("0704.0001", "0704.0001"),
            ("hep-th/9711200", "hep-th/9711200"),
            ("math.GT/0309136", "math.GT/0309136"),
            ("quant-ph/9512032v1", "quant-ph/9512032v1"),
            ("https://arxiv.org/abs/2103.05577", "2103.05577"),
            ("https://arxiv.org/pdf/2103.05577v3.pdf", "2103.05577v3"),
            (
                "http://export.arxiv.org/abs/quant-ph/9512032",
                "quant-ph/9512032",
            ),
            ("www.arxiv.org/html/2103.05577v1", "2103.05577v1"),
            ("https://arxiv.org/abs/2103.05577?context=cs", "2103.05577"),
        ] {
            assert_eq!(clean_arxiv(raw).as_deref(), Some(want), "{raw}");
        }
        for bad in [
            "",
            "2103.055",
            "21030.5577",
            "2103.055778",
            "2103.05577v",
            "hep-th/971120",
            "HEP-TH/9711200",
            "https://arxiv.org/list/2103.05577",
            "https://example.org/abs/2103.05577",
            "10.1038/nature12373",
            "2103.05577 v2",
        ] {
            assert_eq!(clean_arxiv(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_body_must_name_exactly_one_kind_of_id() {
        assert_eq!(
            wanted(&json!({ "doi": "10.1038/nature12373" })).unwrap(),
            Wanted::Doi("10.1038/nature12373".into())
        );
        assert_eq!(
            wanted(&json!({ "arxiv": "2103.05577" })).unwrap(),
            Wanted::Arxiv("2103.05577".into())
        );
        for bad in [
            json!({}),
            json!({ "doi": "10.1038/x", "arxiv": "2103.05577" }),
            json!({ "doi": 5 }),
            json!({ "arxiv": null }),
            json!({ "doi": "nature" }),
            json!({ "arxiv": "nope" }),
            json!([]),
            json!("10.1038/x"),
        ] {
            assert!(
                matches!(wanted(&bad), Err(ApiError::BadRequest(_))),
                "{bad}"
            );
        }
    }

    #[test]
    fn markup_and_entities_become_plain_text() {
        for (raw, want) in [
            ("Plain title", "Plain title"),
            ("Line<br/>break", "Line break"),
            ("The <i>in vivo</i> case", "The in vivo case"),
            ("H<sub>2</sub>O splitting", "H2O splitting"),
            (
                "Tom &amp; Jerry &#8211; a &#x2014; b",
                "Tom & Jerry – a — b",
            ),
            ("x &lt; y and &lt;i&gt;z&lt;/i&gt;", "x < y and z"),
            ("x < y", "x < y"),
            ("<mml:math><mml:mi>α</mml:mi></mml:math>-decay", "α-decay"),
            ("  many\n   spaces\t", "many spaces"),
            ("&unknown; &amp", "&unknown; &amp"),
            ("Caf&eacute;", "Café"),
        ] {
            assert_eq!(plain_text(raw), want, "{raw}");
        }
    }

    #[test]
    fn crossref_answers_are_read_and_drift_is_tolerated() {
        let body = json!({
            "status": "ok",
            "message": {
                "DOI": "10.1103/PhysRevLett.35.1792",
                "title": ["Solvable Model of a <i>Spin-Glass</i>"],
                "author": [
                    { "given": "David", "family": "Sherrington" },
                    { "family": "Kirkpatrick" },
                    { "name": "The ATLAS Collaboration" },
                    { "given": "" },
                    "odd"
                ],
                "issued": { "date-parts": [[1975, 12, 29]] },
                "created": { "date-parts": [[2002, 7, 27]] }
            }
        });
        let found =
            parse_crossref(body.to_string().as_bytes(), "10.1103/physrevlett.35.1792").unwrap();
        assert_eq!(
            found,
            Found {
                title: "Solvable Model of a Spin-Glass".into(),
                authors: "David Sherrington, Kirkpatrick, The ATLAS Collaboration".into(),
                year: "1975".into(),
                doi: Some("10.1103/PhysRevLett.35.1792".into()),
                url: None,
            }
        );
        // Nothing but a message: every field empty, the DOI asked for.
        let bare = parse_crossref(br#"{"message":{}}"#, "10.1/x").unwrap();
        assert_eq!(bare.title, "");
        assert_eq!(bare.authors, "");
        assert_eq!(bare.year, "");
        assert_eq!(bare.doi.as_deref(), Some("10.1/x"));
        // No issued date: the next one that is there.
        let later = json!({ "message": { "issued": { "date-parts": [[null]] }, "created": { "date-parts": [["2002"]] } } });
        assert_eq!(
            parse_crossref(later.to_string().as_bytes(), "10.1/x")
                .unwrap()
                .year,
            "2002"
        );
        for bad in [&b"not json"[..], b"[]", br#"{"message":"x"}"#, b"{}", b""] {
            assert_eq!(parse_crossref(bad, "10.1/x"), Err(Fault::Nonsense));
        }
    }

    #[test]
    fn long_author_lists_end_in_et_al() {
        let names: Vec<String> = (0..MAX_AUTHORS + 5).map(|i| format!("A{i}")).collect();
        let joined = join_authors(names);
        assert!(joined.ends_with("A99, et al."), "{joined}");
        assert_eq!(join_authors(vec!["A".into(), "B".into()]), "A, B");
        assert_eq!(join_authors(vec![]), "");
    }

    pub const ATOM: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">ArXiv Query: id_list=2103.05577</title>
  <entry>
    <id>http://arxiv.org/abs/2103.05577v1</id>
    <published>2021-03-09T17:02:11Z</published>
    <title>Quantum   error correction
      &amp; the surface code</title>
    <author><name>Alexei Kitaev</name></author>
    <author>
      <name>John Preskill</name>
      <arxiv:affiliation xmlns:arxiv="http://arxiv.org/schemas/atom">Caltech</arxiv:affiliation>
    </author>
    <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.1103/PhysRevX.1.1</arxiv:doi>
  </entry>
</feed>"#;

    #[test]
    fn arxiv_feeds_are_read() {
        let found = parse_arxiv(ATOM.as_bytes(), "2103.05577").unwrap();
        assert_eq!(
            found,
            Found {
                title: "Quantum error correction & the surface code".into(),
                authors: "Alexei Kitaev, John Preskill".into(),
                year: "2021".into(),
                doi: Some("10.1103/PhysRevX.1.1".into()),
                url: Some("https://arxiv.org/abs/2103.05577".into()),
            }
        );
        let empty = r#"<feed xmlns="http://www.w3.org/2005/Atom"><title>x</title></feed>"#;
        assert_eq!(parse_arxiv(empty.as_bytes(), "1"), Err(Fault::Unknown));
        let error = r#"<feed><entry><id>http://arxiv.org/api/errors#incorrect_id_format_for_x</id><title>Error</title></entry></feed>"#;
        assert_eq!(parse_arxiv(error.as_bytes(), "1"), Err(Fault::Unknown));
        let blank = r#"<feed><entry><id>http://arxiv.org/abs/2101.99999</id><title></title></entry></feed>"#;
        assert_eq!(parse_arxiv(blank.as_bytes(), "1"), Err(Fault::Unknown));
        for bad in [&b"<html>oops</html>"[..], b"", b"\xff\xfe"] {
            assert_eq!(parse_arxiv(bad, "1"), Err(Fault::Nonsense));
        }
    }

    #[test]
    fn a_doi_goes_into_the_path_encoded() {
        assert_eq!(encode_path("10.1038/nature12373"), "10.1038/nature12373");
        assert_eq!(
            encode_path("10.1002/(SICI)1:15<1661::AID>3.0.CO;2-2#x?y"),
            "10.1002/%28SICI%291%3A15%3C1661%3A%3AAID%3E3.0.CO%3B2-2%23x%3Fy"
        );
    }
}
