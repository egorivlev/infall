//! A PDF on a Source (docs/specs/pdf-sources.md, Part 1; api.md §20): PDFs stored once by
//! the SHA-256 of their bytes, served with `Range`, the text of their pages for search and
//! the reader's find, and a PDF fetched from arXiv on a Member's request.
//!
//! Which PDF a Source has is Research Content — the Source's `pdf` (the hash), `pdf_name`,
//! `pdf_size` and `pdf_pages`, through the ordinary ops — so History, Merge, Restore and
//! Undo need nothing here. The bytes live outside the Change log, in the database beside
//! it (`store::files`), and are never removed (decision 3).
//!
//! Who: Members and Admins. A Guest reads a PDF, and its text, only when a Source on the
//! present Board of `main` names its hash; for any other hash a Guest gets the same `404`
//! as for one that was never stored, so nothing about other Branches or the past leaks.

use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{Path as UrlPath, State};
use axum::http::header::{
    ACCEPT_RANGES, CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE,
    ETAG, IF_NONE_MATCH, IF_RANGE, RANGE, X_CONTENT_TYPE_OPTIONS,
};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{Stream, StreamExt};
use infall_core::{EntityKind, Op, Value as FieldValue};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::app::{Shared, blocking};
use crate::auth::{MemberOrAdmin, SignedIn};
use crate::error::{ApiError, ApiJson, ApiQuery};
use crate::store::{CHUNK_BYTES, Role, TextOutcome};

/// The Source fields that say which PDF it has (M19, decision 2).
pub const PDF_FIELD: &str = "pdf";
pub const PDF_NAME_FIELD: &str = "pdf_name";
pub const PDF_SIZE_FIELD: &str = "pdf_size";
pub const PDF_PAGES_FIELD: &str = "pdf_pages";
/// The longest `pdf_name`, in characters.
pub const MAX_PDF_NAME_CHARS: usize = 255;
/// The largest body `PUT /api/files/pdf/{hash}/text` takes.
pub const MAX_TEXT_BODY_BYTES: u64 = 20 * 1024 * 1024;
/// The most pages a stored text may have.
pub const MAX_TEXT_PAGES: usize = 100_000;
/// The most results one search gives.
pub const MAX_SEARCH_RESULTS: usize = 50;
/// The longest snippet of a search result, in characters.
pub const SNIPPET_CHARS: usize = 200;
/// The longest search query, in characters.
pub const MAX_QUERY_CHARS: usize = 200;
/// PDFs fetched from arXiv per Member per minute, as many as Source lookups.
pub const FETCHES_PER_MINUTE: usize = crate::sources::LOOKUPS_PER_MINUTE;
/// How every PDF starts.
const PDF_MAGIC: &[u8; 5] = b"%PDF-";
/// A whole number a JavaScript number holds exactly.
const MAX_WHOLE: f64 = 9_007_199_254_740_991.0;

const ARXIV_PDF_UNKNOWN: &str =
    "arXiv has no PDF for this id. Check the id, or download the PDF yourself and attach it.";
const ARXIV_PDF_DOWN: &str = "arXiv could not be reached. Check the internet connection and try again, or download the PDF yourself and attach it.";
const ARXIV_PDF_BUSY: &str = "arXiv is not giving out this PDF right now. Try again later, or download the PDF yourself and attach it.";
const ARXIV_PDF_SLOW: &str = "arXiv did not send the PDF within 30 seconds. Try again, or download the PDF yourself and attach it.";
const ARXIV_PDF_NOT_PDF: &str = "arXiv sent something that is not a PDF. The paper may have no PDF yet; download it yourself and attach it.";
const ARXIV_PDF_BROKEN: &str = "The PDF from arXiv did not arrive whole. Try again, or download the PDF yourself and attach it.";

// ---------------------------------------------------------------- the Source fields

/// Whether `s` is a hash as the server makes them: 64 lowercase hex characters.
pub fn is_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The hash of `bytes`, as stored and as a Source names it.
pub fn hash_of(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_pdf_field(field: &str) -> bool {
    matches!(
        field,
        PDF_FIELD | PDF_NAME_FIELD | PDF_SIZE_FIELD | PDF_PAGES_FIELD
    )
}

/// The shape of one of a Source's PDF fields: `pdf` a hash, `pdf_name` 1–255 characters on
/// one line, `pdf_size` and `pdf_pages` whole numbers from 0. Null clears any of them, and
/// a value of the wrong type is left for the core to refuse. Fields that are not these
/// pass.
pub fn check_field(field: &str, value: &FieldValue) -> Result<(), String> {
    match (field, value) {
        (_, FieldValue::Null) => Ok(()),
        (PDF_FIELD, FieldValue::Text(t)) if !is_hash(t) => Err(
            "The `pdf` of a Source must be the hash the server gave for the file: 64 lowercase hex characters."
                .to_string(),
        ),
        (PDF_NAME_FIELD, FieldValue::Text(t))
            if t.is_empty()
                || t.chars().count() > MAX_PDF_NAME_CHARS
                || t.chars().any(char::is_control) =>
        {
            Err(format!(
                "The `pdf_name` of a Source must be 1 to {MAX_PDF_NAME_CHARS} characters on one line."
            ))
        }
        (PDF_SIZE_FIELD | PDF_PAGES_FIELD, FieldValue::Float(n))
            if !(n.is_finite() && *n >= 0.0 && n.fract() == 0.0 && *n <= MAX_WHOLE) =>
        {
            Err(format!(
                "The `{field}` of a Source must be a whole number, 0 or more."
            ))
        }
        _ => Ok(()),
    }
}

/// Checks every PDF field that `ops` write (a Create of a Source, or a Set of one of the
/// fields; on any other kind the core refuses the field anyway).
pub fn check_ops(ops: &[Op]) -> Result<(), ApiError> {
    for op in ops {
        match op {
            Op::Create {
                kind: EntityKind::Source,
                fields,
                ..
            } => {
                for (field, value) in fields.iter().filter(|(f, _)| is_pdf_field(f)) {
                    check_field(field, value).map_err(ApiError::BadRequest)?;
                }
            }
            Op::Set { field, value, .. } if is_pdf_field(field) => {
                check_field(field, value).map_err(ApiError::BadRequest)?;
            }
            _ => {}
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- who may read what

/// The hashes the Sources on the present Board of `main` name: what a Guest may read.
async fn hashes_on_main(st: &Shared) -> Result<HashSet<String>, ApiError> {
    let ws = st.workspace.read().await;
    let Some(main) = ws.branch_by_name("main") else {
        return Ok(HashSet::new());
    };
    let board = ws.head_board(main.id()).map_err(ApiError::internal)?;
    drop(ws);
    Ok(board
        .entities()
        .filter(|(id, e)| e.kind == EntityKind::Source && board.is_visible(*id))
        .filter_map(|(_, e)| match e.get(PDF_FIELD) {
            FieldValue::Text(h) => Some(h.clone()),
            _ => None,
        })
        .collect())
}

/// Whether `who` may read the file `hash`: a Member always; a Guest only when a Source on
/// the present Board of `main` names it.
async fn may_read(st: &Shared, who: &SignedIn, hash: &str) -> Result<bool, ApiError> {
    if who.member.role != Role::Guest {
        return Ok(true);
    }
    Ok(hashes_on_main(st).await?.contains(hash))
}

/// The hash in a path, once `who` may read it: a path that is no hash, or a file a Guest may
/// not read, is `404 not_found` either way.
async fn readable(st: &Shared, who: &SignedIn, hash: &str) -> Result<(), ApiError> {
    if !is_hash(hash) || !may_read(st, who, hash).await? {
        return Err(ApiError::NotFound);
    }
    Ok(())
}

// ---------------------------------------------------------------- receiving a file

/// Why a file did not arrive as a PDF.
#[derive(Debug)]
enum Receive {
    NotAPdf,
    TooLarge,
    /// The sender stopped sending (or the connection broke).
    Broken,
    /// Nothing more arrived in time.
    Slow,
    Io(String),
}

/// What arrived.
struct Received {
    hash: String,
    size: u64,
}

/// Writes `stream` to `to` (a new private file) while hashing it; refuses it as soon as its
/// first bytes are not `%PDF-` or it passes `limit` bytes. With `idle`, also when nothing
/// arrives for that long.
async fn receive<S, B, E>(
    mut stream: S,
    to: &Path,
    limit: u64,
    idle: Option<Duration>,
) -> Result<Received, Receive>
where
    S: Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
{
    use tokio::io::AsyncWriteExt;
    let file = crate::local::port::create_private(to).map_err(|e| Receive::Io(e.to_string()))?;
    let mut file = tokio::fs::File::from_std(file);
    let mut hasher = Sha256::new();
    let mut size: u64 = 0;
    let mut head: Vec<u8> = Vec::with_capacity(PDF_MAGIC.len());
    loop {
        let next = match idle {
            Some(d) => tokio::time::timeout(d, stream.next())
                .await
                .map_err(|_| Receive::Slow)?,
            None => stream.next().await,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|_| Receive::Broken)?;
        let chunk = chunk.as_ref();
        if head.len() < PDF_MAGIC.len() {
            let take = (PDF_MAGIC.len() - head.len()).min(chunk.len());
            head.extend_from_slice(&chunk[..take]);
            if !PDF_MAGIC.starts_with(&head) {
                return Err(Receive::NotAPdf);
            }
        }
        size += chunk.len() as u64;
        if size > limit {
            return Err(Receive::TooLarge);
        }
        hasher.update(chunk);
        file.write_all(chunk)
            .await
            .map_err(|e| Receive::Io(e.to_string()))?;
    }
    if head.len() < PDF_MAGIC.len() {
        return Err(Receive::NotAPdf);
    }
    file.flush().await.map_err(|e| Receive::Io(e.to_string()))?;
    file.sync_all()
        .await
        .map_err(|e| Receive::Io(e.to_string()))?;
    Ok(Received {
        hash: hex(&hasher.finalize()),
        size,
    })
}

fn too_large(limit: u64) -> ApiError {
    ApiError::TooLarge(format!(
        "A PDF may be at most {} MB here.",
        limit / (1024 * 1024)
    ))
}

/// What `PUT /api/files/pdf` and `POST /api/sources/fetch-pdf` answer.
#[derive(Debug, Serialize)]
pub struct Stored {
    pub hash: String,
    pub size: u64,
    /// Always null: the page count is the web UI's to find out (it fills `pdf_pages`).
    pub pages: Option<u64>,
}

/// Receives a file into a scratch file beside the database and stores it (once: a file
/// already stored is not stored again). `fault` turns a refusal into the answer.
async fn receive_and_store<S, B, E>(
    st: &Shared,
    stream: S,
    idle: Option<Duration>,
    fault: impl Fn(Receive) -> ApiError,
) -> Result<Stored, ApiError>
where
    S: Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
{
    let scratch = crate::transfer::scratch_file(st, "pdf")?;
    let result = async {
        let got = receive(stream, &scratch, st.config.max_pdf_bytes, idle)
            .await
            .map_err(&fault)?;
        let (hash, size, at) = (got.hash.clone(), got.size, st.clock.now());
        let from = scratch.clone();
        let new = blocking(st, move |s| s.insert_pdf(&hash, size, &from, at)).await?;
        if new {
            tracing::info!(size = got.size, "pdf stored");
        }
        Ok(Stored {
            hash: got.hash,
            size: got.size,
            pages: None,
        })
    }
    .await;
    let _ = tokio::fs::remove_file(&scratch).await;
    result
}

/// `PUT /api/files/pdf`: the body is the PDF. Answers its hash and size; storing the same
/// bytes again stores nothing and answers the same.
pub async fn put_pdf(
    State(st): State<Shared>,
    MemberOrAdmin(_who): MemberOrAdmin,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<Stored>, ApiError> {
    let limit = st.config.max_pdf_bytes;
    let declared = headers
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if declared.is_some_and(|n| n > limit) {
        return Err(too_large(limit));
    }
    let stored = receive_and_store(&st, body.into_data_stream(), None, |r| match r {
        Receive::NotAPdf => ApiError::NotAPdf,
        Receive::TooLarge => too_large(limit),
        Receive::Broken | Receive::Slow => {
            ApiError::BadRequest("The PDF did not arrive whole.".to_string())
        }
        Receive::Io(e) => ApiError::internal(e),
    })
    .await?;
    Ok(Json(stored))
}

// ---------------------------------------------------------------- serving a file

/// A `Range` that lies outside the file (`416`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unsatisfiable;

/// The one range of `size` bytes that a `Range` header asks for, as `(first, last)`
/// inclusive. `Ok(None)`: the whole file (no header, one this server does not read — several
/// ranges, another unit, a malformed one — all of which a server may ignore). `Err`: a
/// well-formed range that lies outside the file.
pub fn parse_range(header: Option<&str>, size: u64) -> Result<Option<(u64, u64)>, Unsatisfiable> {
    let Some(spec) = header.and_then(|h| h.trim().strip_prefix("bytes=")) else {
        return Ok(None);
    };
    let spec = spec.trim();
    if spec.contains(',') {
        return Ok(None);
    }
    let Some((a, b)) = spec.split_once('-') else {
        return Ok(None);
    };
    let (a, b) = (a.trim(), b.trim());
    let num = |s: &str| -> Option<u64> {
        (!s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()))
            .then(|| s.parse().ok())
            .flatten()
    };
    match (a.is_empty(), b.is_empty()) {
        // `bytes=-n`: the last n bytes.
        (true, false) => {
            let Some(n) = num(b) else { return Ok(None) };
            if n == 0 || size == 0 {
                return Err(Unsatisfiable);
            }
            Ok(Some((size.saturating_sub(n), size - 1)))
        }
        // `bytes=a-`: from a to the end.
        (false, true) => {
            let Some(first) = num(a) else { return Ok(None) };
            if first >= size {
                return Err(Unsatisfiable);
            }
            Ok(Some((first, size - 1)))
        }
        (false, false) => {
            let (Some(first), Some(last)) = (num(a), num(b)) else {
                return Ok(None);
            };
            if last < first {
                return Ok(None);
            }
            if first >= size {
                return Err(Unsatisfiable);
            }
            Ok(Some((first, last.min(size - 1))))
        }
        (true, true) => Ok(None),
    }
}

/// The bytes `first..=last` of the stored file, read part by part as they are sent.
fn file_body(st: Shared, hash: String, first: u64, last: u64) -> Body {
    let (from, to) = (first / CHUNK_BYTES, last / CHUNK_BYTES);
    let stream = futures_util::stream::unfold(from, move |n| {
        let (st, hash) = (st.clone(), hash.clone());
        async move {
            if n > to {
                return None;
            }
            let got = blocking(&st, move |s| s.pdf_chunk(&hash, n)).await;
            let chunk = match got {
                Ok(Some(chunk)) => chunk,
                Ok(None) => {
                    tracing::error!("a stored PDF is missing a part");
                    return Some((Err(std::io::Error::other("missing part")), to + 1));
                }
                Err(e) => {
                    tracing::error!("reading a stored PDF: {e}");
                    return Some((Err(std::io::Error::other("read failed")), to + 1));
                }
            };
            let base = n * CHUNK_BYTES;
            let lo = if n == from {
                (first - base) as usize
            } else {
                0
            };
            let hi = if n == to {
                ((last - base + 1) as usize).min(chunk.len())
            } else {
                chunk.len()
            };
            let part = Bytes::from(chunk).slice(lo.min(hi)..hi);
            Some((Ok::<_, std::io::Error>(part), n + 1))
        }
    });
    Body::from_stream(stream)
}

/// The headers every answer with a file's bytes carries: never sniffed, never anything but a
/// PDF, shown in place, kept by the browser for good (the bytes of a hash never change), but
/// only for this person.
fn file_headers(h: &mut HeaderMap, hash: &str) {
    h.insert(CONTENT_TYPE, HeaderValue::from_static("application/pdf"));
    h.insert(CONTENT_DISPOSITION, HeaderValue::from_static("inline"));
    h.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(
        CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    h.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if let Ok(tag) = HeaderValue::from_str(&format!("\"{hash}\"")) {
        h.insert(ETAG, tag);
    }
}

/// `GET /api/files/pdf/{hash}`: the bytes, whole or the one range asked for.
pub async fn get_pdf(
    State(st): State<Shared>,
    who: SignedIn,
    UrlPath(hash): UrlPath<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    readable(&st, &who, &hash).await?;
    let file = {
        let hash = hash.clone();
        blocking(&st, move |s| s.pdf_file(&hash)).await?
    }
    .ok_or(ApiError::FileMissing)?;
    let tag = format!("\"{hash}\"");
    let header = |name| {
        headers
            .get(name)
            .and_then(|v: &HeaderValue| v.to_str().ok())
    };
    if header(IF_NONE_MATCH)
        .is_some_and(|v| v.split(',').any(|t| t.trim() == tag || t.trim() == "*"))
    {
        let mut res = StatusCode::NOT_MODIFIED.into_response();
        file_headers(res.headers_mut(), &hash);
        res.headers_mut().remove(CONTENT_TYPE);
        return Ok(res);
    }
    // `If-Range` with another validator than this file's: the whole file.
    let range_header = match header(IF_RANGE) {
        Some(v) if v.trim() != tag => None,
        _ => header(RANGE),
    };
    let size = file.size;
    let range = parse_range(range_header, size)
        .map_err(|Unsatisfiable| ApiError::RangeNotSatisfiable(size))?;
    let (status, first, last) = match range {
        Some((first, last)) => (StatusCode::PARTIAL_CONTENT, first, last),
        None => (StatusCode::OK, 0, size - 1),
    };
    let mut res = file_body(st.clone(), hash.clone(), first, last).into_response();
    *res.status_mut() = status;
    let h = res.headers_mut();
    file_headers(h, &hash);
    h.insert(CONTENT_LENGTH, HeaderValue::from(last - first + 1));
    if status == StatusCode::PARTIAL_CONTENT {
        let range = format!("bytes {first}-{last}/{size}");
        h.insert(
            CONTENT_RANGE,
            HeaderValue::from_str(&range).map_err(ApiError::internal)?,
        );
    }
    Ok(res)
}

// ---------------------------------------------------------------- the text of a file

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TextBody {
    pages: Vec<String>,
}

/// The request body, refusing more than `limit` bytes as `413 too_large`.
async fn read_body(headers: &HeaderMap, body: Body, limit: u64) -> Result<Vec<u8>, ApiError> {
    let too_large = || {
        ApiError::TooLarge(format!(
            "The text of a PDF may be at most {} MB.",
            limit / (1024 * 1024)
        ))
    };
    let declared = headers
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if declared.is_some_and(|n| n > limit) {
        return Err(too_large());
    }
    let mut stream = body.into_data_stream();
    let mut out = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk
            .map_err(|_| ApiError::BadRequest("The request body did not arrive whole.".into()))?;
        if (out.len() + chunk.len()) as u64 > limit {
            return Err(too_large());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// `PUT /api/files/pdf/{hash}/text`: `{ "pages": ["text of page 1", …] }`. Stored once: the
/// first text a file gets stays, and a later one is answered `stored: false`.
pub async fn put_text(
    State(st): State<Shared>,
    MemberOrAdmin(_who): MemberOrAdmin,
    UrlPath(hash): UrlPath<String>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<Value>, ApiError> {
    if !is_hash(&hash) {
        return Err(ApiError::NotFound);
    }
    let bytes = read_body(&headers, body, MAX_TEXT_BODY_BYTES).await?;
    let TextBody { pages } = serde_json::from_slice(&bytes).map_err(|_| {
        ApiError::BadRequest(
            "Send the text as { \"pages\": [\"text of page 1\", …] }, one string per page."
                .to_string(),
        )
    })?;
    if pages.len() > MAX_TEXT_PAGES {
        return Err(ApiError::BadRequest(format!(
            "A PDF's text may have at most {MAX_TEXT_PAGES} pages."
        )));
    }
    let outcome = blocking(&st, move |s| s.set_pdf_text(&hash, &pages)).await?;
    match outcome {
        TextOutcome::NoFile => Err(ApiError::FileMissing),
        TextOutcome::Stored => Ok(Json(json!({ "stored": true }))),
        TextOutcome::AlreadyStored => Ok(Json(json!({ "stored": false }))),
    }
}

/// `GET /api/files/pdf/{hash}/text`: `{ "pages": [...] }` as first stored.
pub async fn get_text(
    State(st): State<Shared>,
    who: SignedIn,
    UrlPath(hash): UrlPath<String>,
) -> Result<Json<Value>, ApiError> {
    readable(&st, &who, &hash).await?;
    let (file, text) = blocking(&st, move |s| Ok((s.pdf_file(&hash)?, s.pdf_text(&hash)?))).await?;
    if file.is_none() {
        return Err(ApiError::FileMissing);
    }
    let pages = text.ok_or(ApiError::NoText)?;
    Ok(Json(json!({ "pages": pages })))
}

// ---------------------------------------------------------------- from arXiv

/// `POST /api/sources/fetch-pdf` `{ "arxiv": "<id>" }`: the server downloads
/// `<arXiv>/pdf/<id>` — only when a Member asks, sending nothing but the id — and stores it
/// as `PUT /api/files/pdf` would.
pub async fn fetch_pdf(
    State(st): State<Shared>,
    MemberOrAdmin(who): MemberOrAdmin,
    ApiJson(body): ApiJson<Value>,
) -> Result<Json<Stored>, ApiError> {
    let bad = || {
        ApiError::BadRequest(
            "Send { \"arxiv\": \"2103.05577\" }: the arXiv id of the paper.".to_string(),
        )
    };
    let obj = body.as_object().ok_or_else(bad)?;
    if obj.len() != 1 {
        return Err(bad());
    }
    let raw = obj.get("arxiv").and_then(Value::as_str).ok_or_else(bad)?;
    let id = crate::sources::clean_arxiv(raw).ok_or_else(|| {
        ApiError::BadRequest(
            "That is not an arXiv id. It looks like 2103.05577, or hep-th/9711200 for older papers."
                .to_string(),
        )
    })?;
    if !st.pdf_fetch_rate.allow(who.id().0, st.clock.now()) {
        return Err(ApiError::TooManyFetches);
    }
    let url = format!(
        "{}/pdf/{}",
        st.config.arxiv_url,
        crate::sources::encode_path(&id)
    );
    let wait = st.config.pdf_fetch_timeout;
    let request = st
        .ai
        .http
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/pdf")
        .send();
    let res = match tokio::time::timeout(wait, request).await {
        Err(_) => {
            tracing::warn!("arxiv pdf: no answer in time");
            return Err(ApiError::FetchFailed(ARXIV_PDF_SLOW));
        }
        Ok(Err(e)) => {
            tracing::warn!(timeout = e.is_timeout(), "arxiv pdf: no answer");
            return Err(ApiError::FetchFailed(ARXIV_PDF_DOWN));
        }
        Ok(Ok(res)) => res,
    };
    let status = res.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(ApiError::LookupNotFound(ARXIV_PDF_UNKNOWN));
    }
    if !status.is_success() {
        tracing::warn!(status = status.as_u16(), "arxiv pdf refused");
        return Err(ApiError::FetchFailed(ARXIV_PDF_BUSY));
    }
    let limit = st.config.max_pdf_bytes;
    if res.content_length().is_some_and(|n| n > limit) {
        return Err(too_large(limit));
    }
    let stored = receive_and_store(&st, res.bytes_stream(), Some(wait), |r| match r {
        Receive::NotAPdf => ApiError::FetchFailed(ARXIV_PDF_NOT_PDF),
        Receive::TooLarge => too_large(limit),
        Receive::Slow => ApiError::FetchFailed(ARXIV_PDF_SLOW),
        Receive::Broken => ApiError::FetchFailed(ARXIV_PDF_BROKEN),
        Receive::Io(e) => ApiError::internal(e),
    })
    .await?;
    Ok(Json(stored))
}

// ---------------------------------------------------------------- search

#[derive(Deserialize)]
pub struct SearchQuery {
    q: Option<String>,
}

/// One page where the words were found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Hit {
    pub hash: String,
    /// Counted from 1.
    pub page: u32,
    pub snippet: String,
}

/// `GET /api/search/pdf?q=`: the pages of stored PDFs whose text holds `q`, ignoring case;
/// one result per page, by hash and page, at most `MAX_SEARCH_RESULTS`. A Guest searches
/// only the PDFs they may read.
pub async fn search(
    State(st): State<Shared>,
    who: SignedIn,
    ApiQuery(query): ApiQuery<SearchQuery>,
) -> Result<Json<Vec<Hit>>, ApiError> {
    let q = query.q.unwrap_or_default();
    let q = q.trim();
    let n = q.chars().count();
    if n == 0 || n > MAX_QUERY_CHARS {
        return Err(ApiError::BadRequest(format!(
            "Search for 1 to {MAX_QUERY_CHARS} characters."
        )));
    }
    let only = if who.member.role == Role::Guest {
        Some(hashes_on_main(&st).await?)
    } else {
        None
    };
    let needle = q
        .split(|c: char| c.is_whitespace() || c.is_control())
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let hits = blocking(&st, move |s| {
        let mut hits = Vec::new();
        s.scan_pdf_text(&mut |hash, page, text| {
            if only.as_ref().is_some_and(|o| !o.contains(hash)) {
                return true;
            }
            if let Some(snippet) = snippet(text, &needle) {
                hits.push(Hit {
                    hash: hash.to_string(),
                    page: page + 1,
                    snippet,
                });
            }
            hits.len() < MAX_SEARCH_RESULTS
        })?;
        Ok(hits)
    })
    .await?;
    Ok(Json(hits))
}

/// Where `needle` (lowercase, white space as single spaces) first is in `text`, ignoring
/// case and how the white space runs: up to
/// `SNIPPET_CHARS` characters of `text` around it, white space collapsed. `None` when it
/// is not there.
pub fn snippet(text: &str, needle: &str) -> Option<String> {
    if needle.is_empty() {
        return None;
    }
    // The lowercase text with each run of white space as one space (a PDF's text breaks
    // lines where the page did), and for each of its bytes the byte of `text` it came from.
    let mut lower = String::with_capacity(text.len());
    let mut from: Vec<usize> = Vec::with_capacity(text.len());
    for (i, c) in text.char_indices() {
        if c.is_whitespace() || c.is_control() {
            if !lower.ends_with(' ') {
                lower.push(' ');
                from.push(i);
            }
            continue;
        }
        for l in c.to_lowercase() {
            let before = lower.len();
            lower.push(l);
            from.extend(std::iter::repeat_n(i, lower.len() - before));
        }
    }
    let at = lower.find(needle)?;
    let start = from[at];
    let last = from[at + needle.len() - 1];
    let end = last + text[last..].chars().next().map_or(0, char::len_utf8);
    let found = text[start..end].chars().count();
    let room = SNIPPET_CHARS.saturating_sub(found);
    let before: Vec<char> = text[..start].chars().rev().take(room / 2).collect();
    let after_room = room - before.len();
    let mut out: String = before.into_iter().rev().collect();
    out.push_str(&text[start..end]);
    out.extend(text[end..].chars().take(after_room));
    let collapsed = out
        .split(|c: char| c.is_whitespace() || c.is_control())
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    Some(collapsed.chars().take(SNIPPET_CHARS).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_are_64_lowercase_hex_characters() {
        let h = hash_of(b"%PDF-1.4");
        assert!(is_hash(&h), "{h}");
        assert!(!is_hash(&h.to_uppercase()));
        assert!(!is_hash(&h[..63]));
        assert!(!is_hash(&format!("{h}0")));
        assert!(!is_hash(&"g".repeat(64)));
        assert!(!is_hash(""));
    }

    #[test]
    fn the_pdf_fields_have_their_shapes() {
        let h = hash_of(b"x");
        let ok = [
            (PDF_FIELD, FieldValue::Text(h.clone())),
            (PDF_FIELD, FieldValue::Null),
            (PDF_NAME_FIELD, FieldValue::Text("paper (final).pdf".into())),
            (PDF_NAME_FIELD, FieldValue::Text("é".repeat(255))),
            (PDF_SIZE_FIELD, FieldValue::Float(0.0)),
            (PDF_PAGES_FIELD, FieldValue::Float(312.0)),
            (PDF_SIZE_FIELD, FieldValue::Float(104_857_600.0)),
            ("title", FieldValue::Text("anything".into())),
        ];
        for (f, v) in ok {
            assert!(check_field(f, &v).is_ok(), "{f} {v:?}");
        }
        let bad = [
            (PDF_FIELD, FieldValue::Text("abc".into())),
            (PDF_FIELD, FieldValue::Text(h.to_uppercase())),
            (PDF_NAME_FIELD, FieldValue::Text(String::new())),
            (PDF_NAME_FIELD, FieldValue::Text("a\nb.pdf".into())),
            (PDF_NAME_FIELD, FieldValue::Text("x".repeat(256))),
            (PDF_SIZE_FIELD, FieldValue::Float(-1.0)),
            (PDF_PAGES_FIELD, FieldValue::Float(1.5)),
            (PDF_PAGES_FIELD, FieldValue::Float(1e300)),
        ];
        for (f, v) in bad {
            assert!(check_field(f, &v).is_err(), "{f} {v:?}");
        }
    }

    #[test]
    fn ranges_are_read_as_one_range_or_the_whole_file() {
        let size = 1000;
        for (h, want) in [
            (None, Ok(None)),
            (Some("bytes=0-99"), Ok(Some((0, 99)))),
            (Some("bytes=900-"), Ok(Some((900, 999)))),
            (Some("bytes=-100"), Ok(Some((900, 999)))),
            (Some("bytes=-5000"), Ok(Some((0, 999)))),
            (Some("bytes=990-5000"), Ok(Some((990, 999)))),
            (Some("bytes=999-999"), Ok(Some((999, 999)))),
            (Some("bytes=0-1,5-6"), Ok(None)),
            (Some("items=0-1"), Ok(None)),
            (Some("bytes=5-1"), Ok(None)),
            (Some("bytes=x-1"), Ok(None)),
            (Some("bytes=-"), Ok(None)),
            (Some("bytes=1000-"), Err(Unsatisfiable)),
            (Some("bytes=1000-1001"), Err(Unsatisfiable)),
            (Some("bytes=-0"), Err(Unsatisfiable)),
        ] {
            assert_eq!(parse_range(h, size), want, "{h:?}");
        }
    }

    #[test]
    fn snippets_show_the_words_where_they_are_ignoring_case() {
        assert_eq!(
            snippet("The Surface Code\nworks.", "surface code").as_deref(),
            Some("The Surface Code works.")
        );
        assert_eq!(snippet("nothing here", "absent"), None);
        // A line break where the page broke the line is a space.
        assert_eq!(
            snippet("the surface\n\t code", "surface code").as_deref(),
            Some("the surface code")
        );
        // Letters whose lowercase is longer or shorter in bytes keep the snippet in place.
        assert_eq!(
            snippet("İstanbul ÉTAT énorme", "état").as_deref(),
            Some("İstanbul ÉTAT énorme")
        );
        let long = format!("{} needle {}", "a".repeat(500), "b".repeat(500));
        let s = snippet(&long, "needle").unwrap();
        assert!(s.chars().count() <= SNIPPET_CHARS, "{}", s.len());
        assert!(s.contains("needle"));
        assert!(s.starts_with('a') && s.ends_with('b'), "{s}");
        // A match longer than a snippet is cut to one.
        let huge = "x".repeat(300);
        assert_eq!(
            snippet(&huge, &huge).unwrap().chars().count(),
            SNIPPET_CHARS
        );
    }
}
