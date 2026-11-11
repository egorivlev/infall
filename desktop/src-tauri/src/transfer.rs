//! Moving files' bytes across the bridge (docs/specs/desktop.md, M18): the Workspace file of
//! a move, from the app to the page (`moveFile`), and a file the page made, from the page to
//! the app (`saveBinaryFile`). No Tauri types.
//!
//! Why chunks of base64 text. The server's pages forbid connecting anywhere but their own
//! origin (`connect-src 'self'`), so the web view cannot reach Tauri's `ipc:` protocol from
//! them and every call goes through the web view's message channel instead. There, a raw
//! (binary) answer is written into the page as a JSON array of numbers, about four characters
//! a byte, and a `Uint8Array` argument goes the same way. Base64 text costs 1.33 characters a
//! byte and travels as one string; chunks of a few megabytes keep each message small enough
//! for the web view and let the page fill one buffer of the file's size.

use std::fs::File;
use std::io::{Read as _, Seek as _, SeekFrom};
use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::Serialize;

const MB: u64 = 1024 * 1024;

/// The largest Workspace file a move hands over: what a Team server takes in by default
/// (`QOOP_MAX_IMPORT_MB`, docs/specs/team-move.md, Contract B).
pub const MAX_MOVE_BYTES: u64 = 512 * MB;
/// The file bytes in one `moveFile` chunk (about 5.6 MB of text).
pub const MOVE_CHUNK_BYTES: usize = 4 * 1024 * 1024;
/// The largest file `saveBinaryFile` saves.
pub const MAX_BINARY_SAVE_BYTES: u64 = 512 * MB;
/// The base64 text one `saveBinaryFile` chunk may carry; the bridge script sends 3 MB of
/// bytes (4 MB of text) at a time.
pub const MAX_SAVE_CHUNK_TEXT: usize = 8 * 1024 * 1024;

const NOT_READ: &str = "The Workspace file could not be read. Try again.";
const NOT_SAVED: &str = "The file could not be saved. Try again.";

/// One piece of a file, for the page: the whole file's size, and the bytes from where it
/// asked, as base64. Empty `data` only at the end of the file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Chunk {
    pub size: u64,
    pub data: String,
}

/// The bytes of `path` from `offset`, at most [`MOVE_CHUNK_BYTES`].
pub fn read_chunk(path: &Path, offset: u64) -> Result<Chunk, String> {
    let mut file = File::open(path).map_err(|_| NOT_READ.to_owned())?;
    let meta = file.metadata().map_err(|_| NOT_READ.to_owned())?;
    if !meta.is_file() {
        return Err(NOT_READ.to_owned());
    }
    let size = meta.len();
    if size > MAX_MOVE_BYTES {
        return Err(too_large(MAX_MOVE_BYTES, "hand over"));
    }
    read_part(&mut file, size, offset, NOT_READ)
}

/// The bytes of an open `file` of `size` bytes from `offset`, at most [`MOVE_CHUNK_BYTES`];
/// `not_read` is the sentence for anything that goes wrong.
pub fn read_part(file: &mut File, size: u64, offset: u64, not_read: &str) -> Result<Chunk, String> {
    if offset > size {
        return Err(not_read.to_owned());
    }
    let wanted = (size - offset).min(MOVE_CHUNK_BYTES as u64) as usize;
    let mut bytes = vec![0u8; wanted];
    file.seek(SeekFrom::Start(offset))
        .and_then(|_| file.read_exact(&mut bytes))
        .map_err(|_| not_read.to_owned())?;
    Ok(Chunk {
        size,
        data: STANDARD.encode(&bytes),
    })
}

pub fn too_large(max: u64, verb: &str) -> String {
    format!("The file is too large to {verb} (at most {} MB).", max / MB)
}

/// A file the page is sending, piece by piece, before the save dialog is shown.
pub struct Upload {
    ticket: String,
    size: usize,
    bytes: Vec<u8>,
}

impl Upload {
    /// Starts receiving a file of `size` bytes.
    pub fn begin(size: u64) -> Result<Upload, String> {
        if size > MAX_BINARY_SAVE_BYTES {
            return Err(too_large(MAX_BINARY_SAVE_BYTES, "save"));
        }
        let mut raw = [0u8; 16];
        getrandom::fill(&mut raw).expect("the operating system provides random bytes");
        Ok(Upload {
            ticket: raw.iter().map(|b| format!("{b:02x}")).collect(),
            size: size as usize,
            bytes: Vec::new(),
        })
    }

    pub fn ticket(&self) -> &str {
        &self.ticket
    }

    pub fn is(&self, ticket: &str) -> bool {
        !ticket.is_empty() && self.ticket == ticket
    }

    /// The next piece: `offset` must be where the last one ended, and the file may not grow
    /// past the size it was begun with.
    pub fn push(&mut self, ticket: &str, offset: u64, data: &str) -> Result<(), String> {
        if !self.is(ticket) || offset != self.bytes.len() as u64 || data.len() > MAX_SAVE_CHUNK_TEXT
        {
            return Err(NOT_SAVED.to_owned());
        }
        let piece = STANDARD.decode(data).map_err(|_| NOT_SAVED.to_owned())?;
        if self.bytes.len() + piece.len() > self.size {
            return Err(NOT_SAVED.to_owned());
        }
        if self.bytes.capacity() == 0 {
            self.bytes.reserve_exact(self.size);
        }
        self.bytes.extend_from_slice(&piece);
        Ok(())
    }

    /// The whole file, once every byte has come.
    pub fn finish(self, ticket: &str) -> Result<Vec<u8>, String> {
        if !self.is(ticket) || self.bytes.len() != self.size {
            return Err(NOT_SAVED.to_owned());
        }
        Ok(self.bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(bytes: &[u8]) -> String {
        STANDARD.encode(bytes)
    }

    #[test]
    fn a_file_is_read_in_chunks_that_add_up_to_it() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("w.infall");
        let bytes: Vec<u8> = (0..MOVE_CHUNK_BYTES * 2 + 1000)
            .map(|i| (i * 31 % 251) as u8)
            .collect();
        std::fs::write(&path, &bytes).unwrap();
        let mut got = Vec::new();
        let mut offset = 0u64;
        let mut calls = 0;
        loop {
            let chunk = read_chunk(&path, offset).unwrap();
            assert_eq!(chunk.size, bytes.len() as u64);
            let piece = STANDARD.decode(&chunk.data).unwrap();
            assert!(piece.len() <= MOVE_CHUNK_BYTES);
            calls += 1;
            if piece.is_empty() {
                break;
            }
            offset += piece.len() as u64;
            got.extend(piece);
            if offset == chunk.size {
                break;
            }
        }
        assert_eq!(calls, 3);
        assert_eq!(got, bytes);
        // At the very end: nothing more, not an error.
        let end = read_chunk(&path, bytes.len() as u64).unwrap();
        assert_eq!(end.data, "");
        // Past the end, a folder, no file.
        assert!(read_chunk(&path, bytes.len() as u64 + 1).is_err());
        assert!(read_chunk(tmp.path(), 0).is_err());
        assert!(read_chunk(&tmp.path().join("missing"), 0).is_err());
        // An empty file is one empty chunk.
        let empty = tmp.path().join("empty");
        std::fs::write(&empty, b"").unwrap();
        assert_eq!(
            read_chunk(&empty, 0).unwrap(),
            Chunk {
                size: 0,
                data: String::new()
            }
        );
    }

    #[test]
    fn a_file_larger_than_a_server_takes_is_not_handed_over() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("big.infall");
        let file = File::create(&path).unwrap();
        // Sparse: no disk is used.
        file.set_len(MAX_MOVE_BYTES + 1).unwrap();
        assert_eq!(
            read_chunk(&path, 0),
            Err("The file is too large to hand over (at most 512 MB).".to_owned())
        );
        file.set_len(MAX_MOVE_BYTES).unwrap();
        assert_eq!(
            read_chunk(&path, MAX_MOVE_BYTES).unwrap().size,
            MAX_MOVE_BYTES
        );
    }

    #[test]
    fn an_upload_takes_its_pieces_in_order_and_no_more_than_it_said() {
        let mut up = Upload::begin(10).unwrap();
        let t = up.ticket().to_owned();
        assert_eq!(t.len(), 32);
        assert_ne!(Upload::begin(10).unwrap().ticket(), t);
        up.push(&t, 0, &b64(b"hello")).unwrap();
        // Out of order, the wrong ticket, not base64, past the size: refused, nothing taken.
        assert!(up.push(&t, 0, &b64(b"again")).is_err());
        assert!(up.push(&t, 7, &b64(b"x")).is_err());
        assert!(up.push("other", 5, &b64(b"x")).is_err());
        assert!(up.push("", 5, &b64(b"x")).is_err());
        assert!(up.push(&t, 5, "not base64!").is_err());
        assert!(up.push(&t, 5, &b64(b"too long")).is_err());
        assert!(
            up.push(&t, 5, &"A".repeat(MAX_SAVE_CHUNK_TEXT + 4))
                .is_err()
        );
        up.push(&t, 5, &b64(b"world")).unwrap();
        assert!(!up.is("other"));
        assert_eq!(up.finish(&t).unwrap(), b"helloworld");

        // Finished early, or with another ticket.
        let mut short = Upload::begin(4).unwrap();
        let t = short.ticket().to_owned();
        short.push(&t, 0, &b64(b"ab")).unwrap();
        assert!(short.finish(&t).is_err());
        let other = Upload::begin(0).unwrap();
        assert!(other.finish("nope").is_err());
        // Nothing at all is a file too.
        let empty = Upload::begin(0).unwrap();
        let t = empty.ticket().to_owned();
        assert_eq!(empty.finish(&t).unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn the_save_limit_is_said_in_megabytes() {
        assert!(Upload::begin(MAX_BINARY_SAVE_BYTES).is_ok());
        assert_eq!(
            Upload::begin(MAX_BINARY_SAVE_BYTES + 1).err(),
            Some("The file is too large to save (at most 512 MB).".to_owned())
        );
        assert!(Upload::begin(u64::MAX).is_err());
    }
}
