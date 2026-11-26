//! Where Local Workspaces' files live (docs/specs/desktop.md, "Where things are kept").
//!
//! On Windows they live, since 0.9.0, in the app's **local** data folder
//! (`%LOCALAPPDATA%\app.infall.desktop\`), not the roaming one where earlier versions kept them
//! (`%APPDATA%\app.infall.desktop\`): a roaming profile copies its folder to a server at every
//! sign-in and sign-out, which a database of hundreds of megabytes must not go through. The
//! list of Workspaces and the Runner's settings stay in the config folder, which is the
//! roaming one, as before. macOS and Linux are unchanged: one data folder, nothing to move.
//!
//! The first start after the update moves each Workspace's folder across: copied, the copy
//! compared byte for byte with the original, then moved into place, then the original
//! removed. Any failure leaves the original where it was and the Workspace is used from there
//! (`Registry`'s `legacy` folder); the start screen says so. No Tauri types.

use std::fs;
use std::io::{self, Read as _};
use std::path::{Path, PathBuf};

/// The folders inside a data folder that hold Workspaces' files, as `workspaces.rs` names
/// them: one folder per Local Workspace, and the files of moves to a Team server.
const LOCAL_DIR: &str = "workspaces";
const MOVES_DIR: &str = "moves";
/// The unpacked web UI (`webui.rs`): rebuilt whenever it is missing, so it is not moved.
const WEB_DIR: &str = "web";
const WEB_MARKER: &str = ".infall-web-digest";
/// A copy on its way in, beside where it goes.
const STAGING_SUFFIX: &str = ".moving";

/// What moving the Workspaces from `old` to `new` did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Moved {
    /// The Local Workspaces (by folder name, their id) now in the new folder.
    pub moved: Vec<String>,
    /// Those still in the old folder, and used from there.
    pub left: Vec<String>,
    /// Moved, but whose old copy could not be removed (it is no longer used).
    pub stale: Vec<String>,
}

impl Moved {
    /// What the start screen says about it, if anything.
    pub fn notice(&self, old: &Path, new: &Path) -> Option<String> {
        if self.left.is_empty() {
            return None;
        }
        let what = if self.left.len() == 1 {
            "One workspace".to_owned()
        } else {
            format!("{} workspaces", self.left.len())
        };
        Some(format!(
            "{what} could not be moved to {} and {} still kept in {}, where Infall goes on using {}. \
             Nothing was lost. Infall tries again at its next start.",
            new.display(),
            if self.left.len() == 1 { "is" } else { "are" },
            old.display(),
            if self.left.len() == 1 { "it" } else { "them" },
        ))
    }
}

/// Moves every Local Workspace folder (and every pending move's file) that is in `old` and
/// not in `new` from `old` to `new`. A Workspace already in `new` is left alone in both. The
/// web UI unpacked in `old` is removed (it is unpacked again where it is needed).
pub fn move_workspaces(old: &Path, new: &Path) -> Moved {
    let mut result = Moved::default();
    if old == new {
        return result;
    }
    let from = old.join(LOCAL_DIR);
    let to = new.join(LOCAL_DIR);
    for id in folder_names(&from, true) {
        let target = to.join(&id);
        if target.exists() {
            continue;
        }
        match move_one(&from.join(&id), &target) {
            Ok(removed) => {
                if !removed {
                    result.stale.push(id.clone());
                }
                result.moved.push(id);
            }
            Err(error) => {
                eprintln!(
                    "Infall: a workspace's folder was not moved ({error}); it stays where it was"
                );
                result.left.push(id);
            }
        }
    }
    let _ = fs::remove_dir(&from);
    // A pending move's file: moved the same way, or left (its move then has no file in the new
    // folder, and the page is told there is nothing to hand over; moving again makes a new one).
    let (moves_from, moves_to) = (old.join(MOVES_DIR), new.join(MOVES_DIR));
    for name in folder_names(&moves_from, false) {
        let target = moves_to.join(&name);
        if !target.exists() && move_one(&moves_from.join(&name), &target).is_err() {
            eprintln!("Infall: the file of a move to a Team server was not moved");
        }
    }
    let _ = fs::remove_dir(&moves_from);
    let web = old.join(WEB_DIR);
    if web.join(WEB_MARKER).is_file() {
        let _ = fs::remove_dir_all(&web);
    }
    result
}

/// The names in `dir` that are folders (`dirs`) or plain files, without links, staging
/// copies or hidden names; sorted.
fn folder_names(dir: &Path, dirs: bool) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| {
            e.file_type()
                .is_ok_and(|t| if dirs { t.is_dir() } else { t.is_file() })
        })
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| !n.starts_with('.'))
        .collect();
    names.sort();
    names
}

/// Copies `src` (a folder or a file) to beside `dest`, checks the copy, moves it into place as
/// `dest`, then removes `src`. Returns whether `src` could be removed. On an error nothing is
/// left at `dest` or beside it, and `src` is as it was.
fn move_one(src: &Path, dest: &Path) -> io::Result<bool> {
    let parent = dest
        .parent()
        .ok_or_else(|| io::Error::other("no parent folder"))?;
    create_private_dir(parent)?;
    let name = dest
        .file_name()
        .ok_or_else(|| io::Error::other("no name"))?
        .to_string_lossy()
        .into_owned();
    let staging = parent.join(format!(".{name}{STAGING_SUFFIX}"));
    remove_any(&staging)?;
    let copied = copy_tree(src, &staging)
        .and_then(|()| same_tree(src, &staging))
        .and_then(|()| fs::rename(&staging, dest));
    if let Err(error) = copied {
        let _ = remove_any(&staging);
        return Err(error);
    }
    Ok(remove_any(src).is_ok())
}

fn remove_any(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Copies a folder (with everything in it) or a file. A link anywhere in it is an error: the
/// app never makes one there, and whatever one points at is not the app's to copy.
fn copy_tree(src: &Path, dest: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(src)?;
    if meta.is_dir() {
        create_private_dir(dest)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_tree(&entry.path(), &dest.join(entry.file_name()))?;
        }
        Ok(())
    } else if meta.is_file() {
        // Permissions come along (the key file stays owner-only on Unix).
        fs::copy(src, dest)?;
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "{} is neither a file nor a folder",
            src.display()
        )))
    }
}

/// Checks that `copy` holds exactly what `original` holds: the same names, the same sizes,
/// the same bytes.
fn same_tree(original: &Path, copy: &Path) -> io::Result<()> {
    let differ = |what: &str| io::Error::other(format!("{what} differs in the copy"));
    let a = fs::symlink_metadata(original)?;
    let b = fs::symlink_metadata(copy)?;
    if a.is_dir() != b.is_dir() || a.is_file() != b.is_file() {
        return Err(differ("a kind of file"));
    }
    if a.is_dir() {
        let names = |dir: &Path| -> io::Result<Vec<std::ffi::OsString>> {
            let mut names = fs::read_dir(dir)?
                .map(|e| e.map(|e| e.file_name()))
                .collect::<io::Result<Vec<_>>>()?;
            names.sort();
            Ok(names)
        };
        let (left, right) = (names(original)?, names(copy)?);
        if left != right {
            return Err(differ("a list of files"));
        }
        for name in left {
            same_tree(&original.join(&name), &copy.join(&name))?;
        }
        return Ok(());
    }
    if a.len() != b.len() {
        return Err(differ("a size"));
    }
    let (mut x, mut y) = (fs::File::open(original)?, fs::File::open(copy)?);
    let (mut bx, mut by) = (vec![0u8; 64 * 1024], vec![0u8; 64 * 1024]);
    loop {
        let n = read_full(&mut x, &mut bx)?;
        let m = read_full(&mut y, &mut by)?;
        if n != m || bx[..n] != by[..m] {
            return Err(differ("a file's content"));
        }
        if n == 0 {
            return Ok(());
        }
    }
}

/// Reads until `buf` is full or the file ends.
fn read_full(file: &mut fs::File, buf: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match file.read(&mut buf[filled..])? {
            0 => break,
            n => filled += n,
        }
    }
    Ok(filled)
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

/// The data folders on this platform: where Workspaces' files live now, and (Windows only)
/// where earlier versions kept them, if that is another folder.
pub fn choose(roaming: PathBuf, local: PathBuf) -> (PathBuf, Option<PathBuf>) {
    choose_for(cfg!(windows), roaming, local)
}

fn choose_for(windows: bool, roaming: PathBuf, local: PathBuf) -> (PathBuf, Option<PathBuf>) {
    if windows {
        let legacy = (roaming != local).then_some(roaming);
        (local, legacy)
    } else {
        (roaming, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Roots {
        _tmp: tempfile::TempDir,
        old: PathBuf,
        new: PathBuf,
    }

    fn roots() -> Roots {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("Roaming").join("app.infall.desktop");
        let new = tmp.path().join("Local").join("app.infall.desktop");
        fs::create_dir_all(&old).unwrap();
        Roots {
            _tmp: tmp,
            old,
            new,
        }
    }

    /// A Local Workspace's folder as the app leaves it: the database, its key, a backup.
    fn workspace(root: &Path, id: &str, content: &str) -> PathBuf {
        let dir = root.join(LOCAL_DIR).join(id);
        fs::create_dir_all(dir.join("backups")).unwrap();
        fs::write(dir.join("workspace.sqlite"), content).unwrap();
        fs::write(dir.join("workspace.sqlite.secret-key"), "key").unwrap();
        fs::write(dir.join("backups/backup-2026-11-24-150405.infall"), "b").unwrap();
        dir
    }

    #[test]
    fn workspaces_in_the_roaming_folder_move_to_the_local_one_whole() {
        let r = roots();
        workspace(&r.old, "aaa", "first");
        workspace(&r.old, "bbb", &"x".repeat(200_000));
        fs::create_dir_all(r.old.join(MOVES_DIR)).unwrap();
        fs::write(r.old.join(MOVES_DIR).join("f.infall"), "move").unwrap();
        fs::create_dir_all(r.old.join(WEB_DIR)).unwrap();
        fs::write(r.old.join(WEB_DIR).join(WEB_MARKER), "digest").unwrap();
        // What else is in the roaming folder stays (the list and the Runner's settings are
        // in the config folder, which is the same folder on Windows).
        fs::write(r.old.join("workspaces.json"), "{}").unwrap();

        let moved = move_workspaces(&r.old, &r.new);
        assert_eq!(moved.moved, vec!["aaa".to_owned(), "bbb".to_owned()]);
        assert!(moved.left.is_empty() && moved.stale.is_empty());
        assert_eq!(moved.notice(&r.old, &r.new), None);
        let a = r.new.join(LOCAL_DIR).join("aaa");
        assert_eq!(
            fs::read_to_string(a.join("workspace.sqlite")).unwrap(),
            "first"
        );
        assert_eq!(
            fs::read_to_string(a.join("workspace.sqlite.secret-key")).unwrap(),
            "key"
        );
        assert!(a.join("backups/backup-2026-11-24-150405.infall").is_file());
        assert_eq!(
            fs::read(r.new.join(LOCAL_DIR).join("bbb/workspace.sqlite"))
                .unwrap()
                .len(),
            200_000
        );
        assert!(!r.old.join(LOCAL_DIR).exists());
        assert_eq!(
            fs::read_to_string(r.new.join(MOVES_DIR).join("f.infall")).unwrap(),
            "move"
        );
        assert!(!r.old.join(MOVES_DIR).exists());
        assert!(!r.old.join(WEB_DIR).exists());
        assert!(r.old.join("workspaces.json").is_file());
        // No staging copy is left.
        let names: Vec<_> = fs::read_dir(r.new.join(LOCAL_DIR))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 2);
        // Again: nothing to do.
        assert_eq!(move_workspaces(&r.old, &r.new), Moved::default());
    }

    #[cfg(unix)]
    #[test]
    fn the_key_stays_owner_only_when_it_moves() {
        use std::os::unix::fs::PermissionsExt;
        let r = roots();
        let dir = workspace(&r.old, "aaa", "db");
        fs::set_permissions(
            dir.join("workspace.sqlite.secret-key"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        move_workspaces(&r.old, &r.new);
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        let moved = r.new.join(LOCAL_DIR).join("aaa");
        assert_eq!(mode(&moved.join("workspace.sqlite.secret-key")), 0o600);
        assert_eq!(mode(&moved), 0o700);
    }

    #[test]
    fn a_workspace_already_in_the_local_folder_is_left_alone_in_both() {
        let r = roots();
        workspace(&r.old, "aaa", "old copy");
        workspace(&r.new, "aaa", "new copy");
        workspace(&r.old, "bbb", "only old");
        let moved = move_workspaces(&r.old, &r.new);
        assert_eq!(moved.moved, vec!["bbb".to_owned()]);
        assert_eq!(
            fs::read_to_string(r.new.join(LOCAL_DIR).join("aaa/workspace.sqlite")).unwrap(),
            "new copy"
        );
        assert_eq!(
            fs::read_to_string(r.old.join(LOCAL_DIR).join("aaa/workspace.sqlite")).unwrap(),
            "old copy"
        );
    }

    #[test]
    fn nothing_to_move_does_nothing() {
        let r = roots();
        assert_eq!(move_workspaces(&r.old, &r.new), Moved::default());
        assert_eq!(
            move_workspaces(&r.old.join("missing"), &r.new),
            Moved::default()
        );
        // The same folder (macOS, Linux): never touched.
        workspace(&r.old, "aaa", "db");
        assert_eq!(move_workspaces(&r.old, &r.old), Moved::default());
        assert!(r.old.join(LOCAL_DIR).join("aaa/workspace.sqlite").is_file());
        // A web folder that is not the app's unpacked UI is not removed.
        fs::create_dir_all(r.old.join(WEB_DIR)).unwrap();
        fs::write(r.old.join(WEB_DIR).join("mine.txt"), "mine").unwrap();
        move_workspaces(&r.old, &r.new);
        assert!(r.old.join(WEB_DIR).join("mine.txt").is_file());
    }

    #[test]
    fn a_copy_that_fails_leaves_the_original_and_says_so() {
        let r = roots();
        workspace(&r.old, "aaa", "db");
        workspace(&r.old, "bbb", "db");
        // Where `bbb` would go is taken by a file, so its folder cannot be made there.
        fs::create_dir_all(r.new.join(LOCAL_DIR)).unwrap();
        fs::write(r.new.join(LOCAL_DIR).join(".bbb.moving"), "").unwrap();
        #[cfg(unix)]
        {
            // And `aaa` holds a link: not the app's to copy.
            std::os::unix::fs::symlink("/etc/hosts", r.old.join(LOCAL_DIR).join("aaa/link"))
                .unwrap();
        }
        let moved = move_workspaces(&r.old, &r.new);
        // The staging name was cleared and `bbb` moved; `aaa` stayed (on Unix).
        assert!(moved.moved.contains(&"bbb".to_owned()));
        #[cfg(unix)]
        {
            assert_eq!(moved.left, vec!["aaa".to_owned()]);
            assert!(r.old.join(LOCAL_DIR).join("aaa/workspace.sqlite").is_file());
            assert!(!r.new.join(LOCAL_DIR).join("aaa").exists());
            assert!(!r.new.join(LOCAL_DIR).join(".aaa.moving").exists());
            let notice = moved.notice(&r.old, &r.new).unwrap();
            assert!(notice.starts_with("One workspace could not be moved to "));
            assert!(notice.contains(&r.old.display().to_string()));
            assert!(notice.contains("Nothing was lost."));
        }

        // On every platform: the local folder cannot take them at all.
        let r = roots();
        workspace(&r.old, "ccc", "db");
        fs::create_dir_all(&r.new).unwrap();
        fs::write(r.new.join(LOCAL_DIR), "a file where the folder should be").unwrap();
        let moved = move_workspaces(&r.old, &r.new);
        assert_eq!(moved.left, vec!["ccc".to_owned()]);
        assert!(moved.moved.is_empty());
        assert_eq!(
            fs::read_to_string(r.old.join(LOCAL_DIR).join("ccc/workspace.sqlite")).unwrap(),
            "db"
        );
        assert!(moved.notice(&r.old, &r.new).is_some());
    }

    #[test]
    fn a_copy_is_compared_byte_for_byte() {
        let r = roots();
        let a = workspace(&r.old, "aaa", "same size");
        let b = r.new.join("copy");
        copy_tree(&a, &b).unwrap();
        assert!(same_tree(&a, &b).is_ok());
        // Same size, other bytes.
        fs::write(b.join("workspace.sqlite"), "SAME SIZE").unwrap();
        assert!(same_tree(&a, &b).is_err());
        fs::write(b.join("workspace.sqlite"), "same size").unwrap();
        // Another size; a file more; a file less.
        fs::write(b.join("backups/backup-2026-11-24-150405.infall"), "bb").unwrap();
        assert!(same_tree(&a, &b).is_err());
        fs::write(b.join("backups/backup-2026-11-24-150405.infall"), "b").unwrap();
        fs::write(b.join("extra"), "").unwrap();
        assert!(same_tree(&a, &b).is_err());
        fs::remove_file(b.join("extra")).unwrap();
        fs::remove_file(b.join("workspace.sqlite.secret-key")).unwrap();
        assert!(same_tree(&a, &b).is_err());
    }

    #[test]
    fn the_notice_counts_what_stayed() {
        let (old, new) = (Path::new("/r"), Path::new("/l"));
        let two = Moved {
            moved: vec![],
            left: vec!["a".into(), "b".into()],
            stale: vec![],
        };
        assert_eq!(
            two.notice(old, new).unwrap(),
            "2 workspaces could not be moved to /l and are still kept in /r, where Infall goes on \
             using them. Nothing was lost. Infall tries again at its next start."
        );
        let stale_only = Moved {
            moved: vec!["a".into()],
            left: vec![],
            stale: vec!["a".into()],
        };
        assert_eq!(stale_only.notice(old, new), None);
    }

    #[test]
    fn only_windows_moves_its_workspaces_to_the_local_folder() {
        let (roaming, local) = (PathBuf::from("R"), PathBuf::from("L"));
        assert_eq!(
            choose_for(true, roaming.clone(), local.clone()),
            (local.clone(), Some(roaming.clone()))
        );
        assert_eq!(
            choose_for(false, roaming.clone(), local.clone()),
            (roaming.clone(), None)
        );
        assert_eq!(
            choose_for(true, local.clone(), local.clone()),
            (local, None)
        );
    }
}
