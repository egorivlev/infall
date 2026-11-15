//! Stored PDFs and the text of their pages (schema version 8; docs/specs/pdf-sources.md,
//! Part 1). A file is kept once, by the SHA-256 of its bytes, in parts of `CHUNK_BYTES`
//! (`pdf_chunks`), so that a range of it is read without the rest. Nothing here is ever
//! deleted (decision 3): a Change on any Branch, now or in the past, may name the hash.

use std::io::Read;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};

use super::StoreResult;

/// The size of one stored part of a file. A range request reads only the parts it covers.
pub const CHUNK_BYTES: u64 = 256 * 1024;

/// A stored file, as the API describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdfFile {
    /// 64 lowercase hex characters.
    pub hash: String,
    pub size: u64,
    /// Whether the text of its pages is stored.
    pub has_text: bool,
}

/// What storing the text of a file did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextOutcome {
    Stored,
    /// The file already had its text; the first one stays.
    AlreadyStored,
    /// No such file is stored.
    NoFile,
}

pub(super) fn file_on(conn: &Connection, hash: &str) -> StoreResult<Option<PdfFile>> {
    Ok(conn
        .query_row(
            "SELECT size, text_pages IS NOT NULL FROM pdf_files WHERE hash = ?1",
            params![hash],
            |r| {
                Ok(PdfFile {
                    hash: hash.to_string(),
                    size: r.get::<_, i64>(0)?.max(0) as u64,
                    has_text: r.get(1)?,
                })
            },
        )
        .optional()?)
}

/// Stores the file at `from` (whose bytes have the SHA-256 `hash` and are `size` long) in one
/// transaction; false, and nothing written, when it is already stored.
pub(super) fn insert_on(
    conn: &mut Connection,
    hash: &str,
    size: u64,
    from: &Path,
    at: i64,
) -> StoreResult<bool> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    if file_on(&tx, hash)?.is_some() {
        return Ok(false);
    }
    tx.execute(
        "INSERT INTO pdf_files (hash, size, created_at, text_pages) VALUES (?1, ?2, ?3, NULL)",
        params![hash, size as i64, at],
    )?;
    let mut file = std::fs::File::open(from)
        .map_err(|e| super::StoreError::Backend(format!("the uploaded file: {e}")))?;
    let mut written: u64 = 0;
    let mut n: i64 = 0;
    loop {
        let mut part = Vec::with_capacity(CHUNK_BYTES as usize);
        (&mut file)
            .take(CHUNK_BYTES)
            .read_to_end(&mut part)
            .map_err(|e| super::StoreError::Backend(format!("the uploaded file: {e}")))?;
        if part.is_empty() {
            break;
        }
        written += part.len() as u64;
        tx.execute(
            "INSERT INTO pdf_chunks (hash, n, bytes) VALUES (?1, ?2, ?3)",
            params![hash, n, part],
        )?;
        n += 1;
    }
    if written != size {
        return Err(super::StoreError::Backend(format!(
            "the uploaded file changed while it was stored ({written} bytes, not {size})"
        )));
    }
    tx.commit()?;
    Ok(true)
}

pub(super) fn chunk_on(conn: &Connection, hash: &str, n: u64) -> StoreResult<Option<Vec<u8>>> {
    Ok(conn
        .query_row(
            "SELECT bytes FROM pdf_chunks WHERE hash = ?1 AND n = ?2",
            params![hash, n as i64],
            |r| r.get(0),
        )
        .optional()?)
}

pub(super) fn set_text_on(
    conn: &mut Connection,
    hash: &str,
    pages: &[String],
) -> StoreResult<TextOutcome> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    match file_on(&tx, hash)? {
        None => return Ok(TextOutcome::NoFile),
        Some(f) if f.has_text => return Ok(TextOutcome::AlreadyStored),
        Some(_) => {}
    }
    {
        let mut insert =
            tx.prepare("INSERT INTO pdf_text (hash, page, text) VALUES (?1, ?2, ?3)")?;
        for (i, text) in pages.iter().enumerate() {
            insert.execute(params![hash, i as i64, text])?;
        }
    }
    tx.execute(
        "UPDATE pdf_files SET text_pages = ?2 WHERE hash = ?1",
        params![hash, pages.len() as i64],
    )?;
    tx.commit()?;
    Ok(TextOutcome::Stored)
}

pub(super) fn text_on(conn: &Connection, hash: &str) -> StoreResult<Option<Vec<String>>> {
    match file_on(conn, hash)? {
        Some(f) if f.has_text => {}
        _ => return Ok(None),
    }
    let mut stmt = conn.prepare("SELECT text FROM pdf_text WHERE hash = ?1 ORDER BY page")?;
    let pages = stmt
        .query_map(params![hash], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(Some(pages))
}

/// Calls `visit(hash, page, text)` for every stored page (pages counted from 0), by hash
/// and page, until it returns false.
pub(super) fn scan_on(
    conn: &Connection,
    visit: &mut dyn FnMut(&str, u32, &str) -> bool,
) -> StoreResult<()> {
    let mut stmt = conn.prepare("SELECT hash, page, text FROM pdf_text ORDER BY hash, page")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let hash: String = row.get(0)?;
        let page: i64 = row.get(1)?;
        let text: String = row.get(2)?;
        if !visit(&hash, page.clamp(0, u32::MAX as i64) as u32, &text) {
            break;
        }
    }
    Ok(())
}
