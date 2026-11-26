//! PDFs across the bridge (docs/specs/pdf-sources.md, Part 1, decision 10 and "Desktop";
//! docs/specs/desktop.md, M19): a folder the person picked and the PDFs read from inside it
//! (`pickFolder`, `readFileIn`), and a PDF the page hands over to be opened in the system's
//! viewer (`openExternally`). No Tauri types.
//!
//! The page never learns a path. A picked folder is an opaque token, valid only while the
//! page that asked for it is shown; what the page may read through it is a PDF inside that
//! folder, after every link in the way has been followed.

use std::collections::VecDeque;
use std::fs::{self, File};
use std::io::{self, Read as _};
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::transfer::{self, Chunk};

const MB: u64 = 1024 * 1024;

/// The largest PDF the bridge reads or opens: the server's own limit (`INFALL_MAX_PDF_MB`,
/// decision 4).
pub const MAX_PDF_BYTES: u64 = 100 * MB;
/// What every PDF starts with. The name of a file says nothing.
pub const PDF_MAGIC: &[u8] = b"%PDF-";
/// How many picked folders a page may hold at once; the oldest is forgotten first.
pub const MAX_FOLDERS: usize = 8;
/// In the app's cache folder: the PDFs handed to the system's viewer, one folder each.
pub const VIEWER_DIR: &str = "opened";

const NOT_READ: &str = "The file could not be read. Try again.";
const NOT_IN_FOLDER: &str = "There is no such file in the folder you chose.";
const NOT_A_PDF: &str = "That file is not a PDF.";
const NO_FOLDER: &str = "Choose the folder again.";

/// Whether `bytes` begin as a PDF does.
pub fn is_pdf(bytes: &[u8]) -> bool {
    bytes.starts_with(PDF_MAGIC)
}

fn too_large() -> String {
    format!(
        "The file is too large to open (at most {} MB).",
        MAX_PDF_BYTES / MB
    )
}

// ---- picked folders -----------------------------------------------------------------------

/// What `pickFolder` answers: the token the page reads files through, and the folder's name
/// to show. Never its path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Picked {
    pub token: String,
    pub name: String,
}

/// The folders the main window's page picked, by token. Forgotten when the page starts
/// loading another page or the window closes (`clear`).
#[derive(Debug, Default)]
pub struct Folders {
    picked: VecDeque<(String, PathBuf)>,
}

impl Folders {
    /// Keeps the folder the person chose and gives the page a token for it. The folder is
    /// kept as its canonical path: what was chosen, with every link in it resolved now.
    pub fn pick(&mut self, chosen: &Path) -> Result<Picked, String> {
        let folder = fs::canonicalize(chosen).map_err(|_| NO_FOLDER.to_owned())?;
        if !folder.is_dir() {
            return Err(NO_FOLDER.to_owned());
        }
        let token = new_token();
        let name = folder_name(&folder);
        if self.picked.len() >= MAX_FOLDERS {
            self.picked.pop_front();
        }
        self.picked.push_back((token.clone(), folder));
        Ok(Picked { token, name })
    }

    /// The folder behind `token`, if the page still holds it.
    pub fn get(&self, token: &str) -> Option<&Path> {
        if token.is_empty() {
            return None;
        }
        self.picked
            .iter()
            .find(|(t, _)| t == token)
            .map(|(_, folder)| folder.as_path())
    }

    pub fn clear(&mut self) {
        self.picked.clear();
    }
}

fn new_token() -> String {
    let mut raw = [0u8; 16];
    getrandom::fill(&mut raw).expect("the operating system provides random bytes");
    raw.iter().map(|b| format!("{b:02x}")).collect()
}

/// The name a folder is shown by: its last part, or the whole path for a root (`/`, `C:\`).
pub fn folder_name(folder: &Path) -> String {
    folder
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| {
            let shown = folder.display().to_string();
            // Windows' canonical paths start with `\\?\`; nobody calls a drive that.
            shown
                .strip_prefix(r"\\?\")
                .map(str::to_owned)
                .unwrap_or(shown)
        })
}

// ---- which file inside the folder ---------------------------------------------------------

/// The file inside `folder` (canonical, as [`Folders::pick`] keeps it) that `given` names: a
/// path relative to the folder, or an absolute one, as a BibTeX `file` field has it. A field
/// written by Zotero, JabRef or Mendeley (`description:path:type`, several separated by `;`,
/// `\:` and `\\` escaped) is read too: its paths are tried in order after `given` itself.
///
/// The first candidate that is an existing file and, once every link is followed, still
/// inside `folder` is the one. Anything that leads out of it — `..`, an absolute path
/// elsewhere, a link to elsewhere — is not there as far as the page is concerned.
pub fn resolve_in(folder: &Path, given: &str) -> Result<PathBuf, String> {
    candidates(given)
        .into_iter()
        .find_map(|candidate| inside(folder, &candidate))
        .ok_or_else(|| NOT_IN_FOLDER.to_owned())
}

fn inside(folder: &Path, candidate: &str) -> Option<PathBuf> {
    if candidate.is_empty() || candidate.contains('\0') {
        return None;
    }
    let path = Path::new(candidate);
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        // A relative path starting at a drive or a root (`C:x`, `\x` on Windows) is not
        // relative to the folder.
        if path
            .components()
            .any(|c| matches!(c, Component::Prefix(_) | Component::RootDir))
        {
            return None;
        }
        folder.join(path)
    };
    let real = fs::canonicalize(joined).ok()?;
    (real.starts_with(folder) && real != folder && real.is_file()).then_some(real)
}

/// What `given` may name, in the order tried: itself, then the paths of a reference
/// manager's `file` field.
fn candidates(given: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut push = |c: String| {
        let c = c.trim().to_owned();
        if !c.is_empty() && !out.contains(&c) {
            out.push(c);
        }
    };
    push(given.to_owned());
    // The escapes are taken away once, by the second split. Taken away by the first too, an
    // escaped `\\` (as in Windows' `\\?\C:\…` or `\\server\share\…`) became `\` and then the
    // escape of whatever followed it: `\\?\C` became `\?\C`.
    for entry in split_at(given, ';', false) {
        let fields = split_at(&entry, ':', true);
        if fields.len() >= 3 {
            // `description:path:type`; a Windows drive's colon left unescaped makes the path
            // two fields (`C`, `\Users\…`), so everything between the first and the last is it.
            push(fields[1..fields.len() - 1].join(":"));
        }
    }
    out
}

/// `text` split at every `sep` that is not escaped with a backslash, with the escapes of the
/// separators and of the backslash itself taken away (`\:` is `:`, `\\` is `\`). Other
/// backslashes stay, so a Windows path written plainly keeps its separators.
#[cfg(test)]
fn split_unescaped(text: &str, sep: char) -> Vec<String> {
    split_at(text, sep, true)
}

/// `text` split at every `sep` that is not escaped with a backslash. With `unescape`, the
/// escapes of `:`, `;` and `\` are taken away (as [`split_unescaped`]); without, every part
/// keeps them as written, for a second split.
fn split_at(text: &str, sep: char, unescape: bool) -> Vec<String> {
    let mut parts = vec![String::new()];
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.peek() {
                Some(&next) if next == ':' || next == ';' || next == '\\' => {
                    let part = parts.last_mut().unwrap();
                    if !unescape {
                        part.push('\\');
                    }
                    part.push(next);
                    chars.next();
                }
                _ => parts.last_mut().unwrap().push('\\'),
            },
            c if c == sep => parts.push(String::new()),
            c => parts.last_mut().unwrap().push(c),
        }
    }
    parts
}

// ---- reading it ---------------------------------------------------------------------------

/// A piece of the PDF at `path` from `offset`, as `moveFile`'s pieces are (see `transfer`).
/// Refused when the file is not a PDF or is larger than [`MAX_PDF_BYTES`], at every piece.
pub fn read_pdf_chunk(path: &Path, offset: u64) -> Result<Chunk, String> {
    let mut file = File::open(path).map_err(|_| NOT_READ.to_owned())?;
    let meta = file.metadata().map_err(|_| NOT_READ.to_owned())?;
    if !meta.is_file() {
        return Err(NOT_READ.to_owned());
    }
    let size = meta.len();
    if size > MAX_PDF_BYTES {
        return Err(too_large());
    }
    let mut head = [0u8; 5];
    if file.read_exact(&mut head).is_err() || !is_pdf(&head) {
        return Err(NOT_A_PDF.to_owned());
    }
    transfer::read_part(&mut file, size, offset, NOT_READ)
}

// ---- opening one in the system's viewer -------------------------------------------------

/// Checks the bytes the page handed over before anything is written: a PDF, not too large.
pub fn check_for_viewer(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 > MAX_PDF_BYTES {
        return Err(too_large());
    }
    if !is_pdf(bytes) {
        return Err(NOT_A_PDF.to_owned());
    }
    Ok(())
}

/// Writes a PDF for the system's viewer into a new folder of its own under
/// `<cache>/opened/`, owner-only, named after `suggested` (made safe, ending in `.pdf`), and
/// returns its path. Everything under `opened/` is deleted when the app quits and when it
/// starts ([`clear_viewer_files`]).
pub fn write_for_viewer(cache: &Path, suggested: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    const NOT_WRITTEN: &str = "The PDF could not be opened on this computer.";
    check_for_viewer(bytes)?;
    let root = cache.join(VIEWER_DIR);
    let dir = root.join(new_token());
    create_private_dir(&root)
        .and_then(|()| create_private_dir(&dir))
        .map_err(|_| NOT_WRITTEN.to_owned())?;
    let path = dir.join(viewer_name(suggested));
    let written = write_private(&path, bytes);
    if written.is_err() {
        let _ = fs::remove_dir_all(&dir);
        return Err(NOT_WRITTEN.to_owned());
    }
    Ok(path)
}

/// The file name a viewer shows: what the page suggested, made safe, always `….pdf`.
pub fn viewer_name(suggested: &str) -> String {
    let safe = crate::portable::safe_file_name(suggested, "Document");
    let stem = match safe.rsplit_once('.') {
        Some((stem, ext)) if ext.eq_ignore_ascii_case("pdf") => stem.to_owned(),
        _ => safe,
    };
    format!("{stem}.pdf")
}

/// Deletes every PDF written for the viewer. Called when the app starts and when it quits; a
/// file a viewer still holds open (Windows) stays until the next time.
pub fn clear_viewer_files(cache: &Path) {
    let root = cache.join(VIEWER_DIR);
    match fs::symlink_metadata(&root) {
        Ok(meta) if meta.is_dir() => {
            let _ = fs::remove_dir_all(&root);
        }
        Ok(_) => {
            let _ = fs::remove_file(&root);
        }
        Err(_) => {}
    }
}

fn create_private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write as _;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    const PDF: &[u8] = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n%%EOF\n";

    struct Picked {
        _tmp: tempfile::TempDir,
        root: PathBuf,
        folder: PathBuf,
    }

    /// `root/picked/` (the folder the person chose) with PDFs in it and below it, and
    /// `root/outside/` beside it.
    fn picked() -> Picked {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let folder = root.join("picked");
        fs::create_dir_all(folder.join("files/12")).unwrap();
        fs::create_dir_all(root.join("outside")).unwrap();
        fs::write(folder.join("paper.pdf"), PDF).unwrap();
        fs::write(folder.join("files/12/Smith 2020 - Axions.pdf"), PDF).unwrap();
        fs::write(folder.join("notes.txt"), "not a pdf").unwrap();
        fs::write(root.join("outside/secret.pdf"), PDF).unwrap();
        Picked {
            _tmp: tmp,
            root,
            folder,
        }
    }

    #[test]
    fn a_picked_folder_is_a_token_and_a_name_never_a_path() {
        let p = picked();
        let mut folders = Folders::default();
        let got = folders.pick(&p.folder).unwrap();
        assert_eq!(got.name, "picked");
        assert_eq!(got.token.len(), 32);
        assert!(!got.token.contains("picked"));
        assert_eq!(folders.get(&got.token), Some(p.folder.as_path()));
        assert_eq!(folders.get(""), None);
        assert_eq!(folders.get("0123"), None);
        // Another pick is another token; the first one still works.
        let second = folders.pick(&p.root.join("outside")).unwrap();
        assert_ne!(second.token, got.token);
        assert!(folders.get(&got.token).is_some());
        // At most a few at once, the oldest forgotten first.
        for _ in 0..MAX_FOLDERS {
            folders.pick(&p.folder).unwrap();
        }
        assert_eq!(folders.get(&got.token), None);
        // The page went away: every token dies with it.
        let last = folders.pick(&p.folder).unwrap();
        folders.clear();
        assert_eq!(folders.get(&last.token), None);
        // Not a folder, or not there.
        assert!(folders.pick(&p.folder.join("paper.pdf")).is_err());
        assert!(folders.pick(&p.folder.join("missing")).is_err());
    }

    #[test]
    fn a_root_is_named_by_its_path() {
        assert_eq!(folder_name(Path::new("/")), "/");
        assert_eq!(folder_name(Path::new("/a/Zotero")), "Zotero");
    }

    #[test]
    fn files_inside_the_folder_are_found_by_relative_and_absolute_paths() {
        let p = picked();
        let f = &p.folder;
        assert_eq!(resolve_in(f, "paper.pdf").unwrap(), f.join("paper.pdf"));
        assert_eq!(
            resolve_in(f, "files/12/Smith 2020 - Axions.pdf").unwrap(),
            f.join("files/12/Smith 2020 - Axions.pdf")
        );
        // `..` that stays inside is still inside.
        assert_eq!(
            resolve_in(f, "files/../paper.pdf").unwrap(),
            f.join("paper.pdf")
        );
        // An absolute path, as a BibTeX `file` field has it, when it is inside.
        let absolute = f.join("paper.pdf").display().to_string();
        assert_eq!(resolve_in(f, &absolute).unwrap(), f.join("paper.pdf"));
        // Spaces around it are not part of it.
        assert_eq!(
            resolve_in(f, "  paper.pdf \n").unwrap(),
            f.join("paper.pdf")
        );
    }

    #[test]
    fn nothing_outside_the_folder_can_be_reached() {
        let p = picked();
        let f = &p.folder;
        let outside = p.root.join("outside/secret.pdf").display().to_string();
        for escape in [
            "../outside/secret.pdf",
            "files/../../outside/secret.pdf",
            outside.as_str(),
            "",
            "files",
            ".",
            "missing.pdf",
            "paper.pdf\0",
        ] {
            assert_eq!(
                resolve_in(f, escape),
                Err(NOT_IN_FOLDER.to_owned()),
                "{escape:?}"
            );
        }
        // The folder itself is not a file in it.
        assert!(resolve_in(f, &f.display().to_string()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_that_leads_out_of_the_folder_is_refused_and_one_inside_is_followed() {
        let p = picked();
        let f = &p.folder;
        std::os::unix::fs::symlink(p.root.join("outside/secret.pdf"), f.join("link.pdf")).unwrap();
        std::os::unix::fs::symlink(p.root.join("outside"), f.join("elsewhere")).unwrap();
        std::os::unix::fs::symlink(f.join("paper.pdf"), f.join("same.pdf")).unwrap();
        assert!(resolve_in(f, "link.pdf").is_err());
        assert!(resolve_in(f, "elsewhere/secret.pdf").is_err());
        assert!(resolve_in(f, &f.join("link.pdf").display().to_string()).is_err());
        assert_eq!(resolve_in(f, "same.pdf").unwrap(), f.join("paper.pdf"));
        // A folder picked through a link is kept as where it really is.
        std::os::unix::fs::symlink(f, p.root.join("via-link")).unwrap();
        let mut folders = Folders::default();
        let t = folders.pick(&p.root.join("via-link")).unwrap();
        assert_eq!(folders.get(&t.token), Some(f.as_path()));
        assert_eq!(t.name, "picked");
    }

    #[test]
    fn a_reference_managers_file_field_is_read() {
        let p = picked();
        let f = &p.folder;
        let abs = f
            .join("files/12/Smith 2020 - Axions.pdf")
            .display()
            .to_string();
        // Zotero: description:path:type, with `:` and `\` escaped.
        let zotero = format!(
            "Full Text PDF:{}:application/pdf",
            abs.replace('\\', "\\\\").replace(':', "\\:")
        );
        assert_eq!(
            resolve_in(f, &zotero).unwrap(),
            f.join("files/12/Smith 2020 - Axions.pdf")
        );
        // JabRef, relative: `:paper.pdf:PDF`; several files, the first one found wins.
        assert_eq!(
            resolve_in(f, ":paper.pdf:PDF").unwrap(),
            f.join("paper.pdf")
        );
        assert_eq!(
            resolve_in(
                f,
                "Snapshot:missing.html:text/html;Full Text:paper.pdf:application/pdf"
            )
            .unwrap(),
            f.join("paper.pdf")
        );
        // A field naming only things outside, or nothing usable.
        let outside = p.root.join("outside/secret.pdf").display().to_string();
        assert!(resolve_in(f, &format!("PDF:{outside}:application/pdf")).is_err());
        assert!(resolve_in(f, "PDF::application/pdf").is_err());
    }

    #[test]
    fn a_field_is_split_at_unescaped_separators() {
        assert_eq!(
            candidates(r"Full Text:C\:\\Users\\me\\Zotero\\a.pdf:application/pdf"),
            vec![
                r"Full Text:C\:\\Users\\me\\Zotero\\a.pdf:application/pdf".to_owned(),
                r"C:\Users\me\Zotero\a.pdf".to_owned()
            ]
        );
        // An unescaped drive letter (Mendeley): everything between the first and last field.
        assert_eq!(
            candidates(r":C:\Users\me\a.pdf:pdf")[1],
            r"C:\Users\me\a.pdf".to_owned()
        );
        // A plain path is tried as it is, once.
        assert_eq!(candidates("files/a.pdf"), vec!["files/a.pdf".to_owned()]);
        assert_eq!(
            split_unescaped(r"a\;b;c", ';'),
            vec!["a;b".to_owned(), "c".to_owned()]
        );
    }

    /// Pure string handling, so it runs on every system: the paths Windows gives a folder
    /// picked there (`fs::canonicalize` makes them `\\?\C:\…`) and network paths begin with
    /// two backslashes, which a reference manager writes escaped as four. They failed
    /// `a_reference_managers_file_field_is_read` on Windows: the escapes were taken away twice.
    #[test]
    fn escaped_double_backslashes_of_windows_paths_survive() {
        assert_eq!(
            candidates(r"Full Text PDF:\\\\?\\C\:\\Users\\me\\a.pdf:application/pdf")[1],
            r"\\?\C:\Users\me\a.pdf".to_owned()
        );
        assert_eq!(
            candidates(r"PDF:\\\\server\\share\\a\;b.pdf:application/pdf")[1],
            r"\\server\share\a;b.pdf".to_owned()
        );
        // Several files: each keeps its own escapes until its own fields are read.
        assert_eq!(
            candidates(r"A:\\\\?\\C\:\\x.pdf:pdf;B:\\\\?\\D\:\\y\;z.pdf:pdf")[1..],
            [r"\\?\C:\x.pdf".to_owned(), r"\\?\D:\y;z.pdf".to_owned()]
        );
        assert_eq!(
            split_at(r"a\\b\;c;d\:e", ';', false),
            vec![r"a\\b\;c".to_owned(), r"d\:e".to_owned()]
        );
    }

    #[test]
    fn only_a_pdf_of_at_most_100_mb_is_read_in_pieces() {
        let p = picked();
        let path = p.folder.join("paper.pdf");
        let chunk = read_pdf_chunk(&path, 0).unwrap();
        assert_eq!(chunk.size, PDF.len() as u64);
        assert_eq!(STANDARD.decode(chunk.data).unwrap(), PDF);
        // From the middle.
        let rest = read_pdf_chunk(&path, 5).unwrap();
        assert_eq!(STANDARD.decode(rest.data).unwrap(), &PDF[5..]);
        assert!(read_pdf_chunk(&path, PDF.len() as u64 + 1).is_err());
        // Not a PDF, whatever it is called.
        let fake = p.folder.join("fake.pdf");
        fs::write(&fake, "<html>").unwrap();
        assert_eq!(read_pdf_chunk(&fake, 0), Err(NOT_A_PDF.to_owned()));
        assert_eq!(
            read_pdf_chunk(&p.folder.join("notes.txt"), 0),
            Err(NOT_A_PDF.to_owned())
        );
        let short = p.folder.join("short.pdf");
        fs::write(&short, "%PD").unwrap();
        assert_eq!(read_pdf_chunk(&short, 0), Err(NOT_A_PDF.to_owned()));
        assert!(read_pdf_chunk(&p.folder, 0).is_err());
        // Too large (sparse, so no disk is used).
        let big = p.folder.join("big.pdf");
        fs::write(&big, PDF).unwrap();
        let file = fs::OpenOptions::new().write(true).open(&big).unwrap();
        file.set_len(MAX_PDF_BYTES + 1).unwrap();
        assert_eq!(
            read_pdf_chunk(&big, 0),
            Err("The file is too large to open (at most 100 MB).".to_owned())
        );
        file.set_len(MAX_PDF_BYTES).unwrap();
        assert_eq!(read_pdf_chunk(&big, 0).unwrap().size, MAX_PDF_BYTES);
    }

    #[test]
    fn a_pdf_for_the_viewer_is_written_privately_and_cleared() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = tmp.path().join("cache");
        let one = write_for_viewer(&cache, "Smith 2020: Axions?.pdf", PDF).unwrap();
        let two = write_for_viewer(&cache, "Smith 2020: Axions?.pdf", PDF).unwrap();
        assert_ne!(one, two, "each in a folder of its own");
        assert_eq!(fs::read(&one).unwrap(), PDF);
        assert_eq!(
            one.file_name().unwrap().to_string_lossy(),
            "Smith 2020- Axions-.pdf"
        );
        assert!(one.starts_with(cache.join(VIEWER_DIR)));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&one), 0o600);
            assert_eq!(mode(one.parent().unwrap()), 0o700);
            assert_eq!(mode(&cache.join(VIEWER_DIR)), 0o700);
        }
        // Only a PDF, only up to the limit.
        assert_eq!(
            write_for_viewer(&cache, "x.pdf", b"MZ\x90\x00"),
            Err(NOT_A_PDF.to_owned())
        );
        assert!(check_for_viewer(&vec![b'%'; MAX_PDF_BYTES as usize + 1]).is_err());
        clear_viewer_files(&cache);
        assert!(!cache.join(VIEWER_DIR).exists());
        assert!(cache.exists());
        // Nothing there: nothing happens.
        clear_viewer_files(&cache);
    }

    #[test]
    fn the_viewer_is_always_given_a_pdf_name() {
        assert_eq!(viewer_name("paper.pdf"), "paper.pdf");
        assert_eq!(viewer_name("paper.PDF"), "paper.pdf");
        assert_eq!(viewer_name("paper.exe"), "paper.exe.pdf");
        assert_eq!(viewer_name("paper"), "paper.pdf");
        assert_eq!(viewer_name(""), "Document.pdf");
        assert_eq!(viewer_name("../../etc/passwd"), "-..-etc-passwd.pdf");
        assert_eq!(viewer_name("CON.pdf"), "CON_.pdf");
    }
}
