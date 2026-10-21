//! The web UI the app was built with (`web/dist`, inside the binary; see build.rs), unpacked
//! to a directory the app owns, for a Local Workspace's server to serve. No Tauri types.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

mod embedded {
    include!(concat!(env!("OUT_DIR"), "/web_dist.rs"));
}

/// The name of the unpacked copy inside the directory given to [`unpack`].
const DIR: &str = "web";
/// Inside the copy: the digest of what was unpacked, written last.
const MARKER: &str = ".infall-web-digest";

/// Unpacks the embedded web UI into `<root>/web` unless that already holds this very build,
/// and returns that directory. A copy of another build is replaced.
pub fn unpack(root: &Path) -> io::Result<PathBuf> {
    unpack_files(root, embedded::FILES, embedded::DIGEST)
}

fn unpack_files(root: &Path, files: &[(&str, &[u8])], digest: &str) -> io::Result<PathBuf> {
    let target = root.join(DIR);
    if fs::read_to_string(target.join(MARKER)).is_ok_and(|d| d == digest) {
        return Ok(target);
    }
    fs::create_dir_all(root)?;
    // Written beside the target and moved into place whole, so a copy is never half there.
    let tmp = root.join(format!("{DIR}.{}.tmp", std::process::id()));
    if tmp.exists() {
        fs::remove_dir_all(&tmp)?;
    }
    let written = (|| {
        for (relative, bytes) in files {
            let path = tmp.join(safe_relative(relative)?);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(path, bytes)?;
        }
        fs::write(tmp.join(MARKER), digest)
    })();
    if let Err(error) = written {
        let _ = fs::remove_dir_all(&tmp);
        return Err(error);
    }
    if target.exists() {
        fs::remove_dir_all(&target)?;
    }
    fs::rename(&tmp, &target)?;
    Ok(target)
}

/// A path from the embedded list, refused if it could point outside the copy.
fn safe_relative(relative: &str) -> io::Result<PathBuf> {
    let path = Path::new(relative);
    let plain = !relative.is_empty()
        && path.components().all(|c| matches!(c, Component::Normal(_)))
        && !relative.contains('\\');
    if plain {
        Ok(path.to_path_buf())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "a path in the embedded web UI is not plain",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_built_web_ui_is_inside_the_binary() {
        assert!(
            embedded::FILES
                .iter()
                .any(|(path, _)| *path == "index.html")
        );
        assert_eq!(embedded::DIGEST.len(), 16);
    }

    #[test]
    fn unpacked_once_and_replaced_when_the_build_differs() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().join("data");
        let first: &[(&str, &[u8])] = &[("index.html", b"one"), ("assets/a.js", b"a")];
        let dir = unpack_files(&root, first, "1111").unwrap();
        assert_eq!(dir, root.join("web"));
        assert_eq!(fs::read(dir.join("index.html")).unwrap(), b"one");
        assert_eq!(fs::read(dir.join("assets/a.js")).unwrap(), b"a");

        // The same build is left alone.
        fs::write(dir.join("index.html"), "touched").unwrap();
        unpack_files(&root, first, "1111").unwrap();
        assert_eq!(fs::read(dir.join("index.html")).unwrap(), b"touched");

        // Another build replaces it whole: nothing of the old one is left.
        let second: &[(&str, &[u8])] = &[("index.html", b"two"), ("assets/b.js", b"b")];
        unpack_files(&root, second, "2222").unwrap();
        assert_eq!(fs::read(dir.join("index.html")).unwrap(), b"two");
        assert!(dir.join("assets/b.js").exists());
        assert!(!dir.join("assets/a.js").exists());
        let leftovers: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(leftovers, ["web"]);
    }

    #[test]
    fn paths_that_leave_the_copy_are_refused() {
        let root = tempfile::tempdir().unwrap();
        for bad in ["../x", "/etc/x", "a/../../x", "", "a\\..\\x", "./x"] {
            let files: &[(&str, &[u8])] = &[(bad, b"x")];
            assert!(unpack_files(root.path(), files, "3333").is_err(), "{bad}");
        }
        assert!(!root.path().join("web").exists());
    }
}
