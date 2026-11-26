//! The app's folders from before the rename (docs/specs/desktop.md, "Names before the
//! rename").
//!
//! Until the rename the app's identifier was `app.qoop.desktop`; it is `app.infall.desktop`
//! now. Tauri names every folder of the app after the identifier, so the new build starts
//! with empty folders: macOS `~/Library/Application Support/<identifier>/` (the list of
//! Workspaces, the Runner's settings and approvals, `window.json`, `updates.json`, every
//! Local Workspace with its backups), Linux `~/.config/<identifier>/` and
//! `~/.local/share/<identifier>/` (the second also holds the web view's own storage),
//! Windows `%APPDATA%\<identifier>\` and `%LOCALAPPDATA%\<identifier>\` (the second also
//! holds WebView2's `EBWebView\`). On macOS the web view keeps its storage apart, in
//! `~/Library/WebKit/<identifier>/`; the caller adds that pair of folders too.
//!
//! The first start under the new identifier, when the new folders hold no Workspace yet and
//! an old one exists, moves what the old folders hold into the new ones, the way `datadir`
//! moves Workspaces on Windows: each Workspace's folder, and then each other file or folder,
//! is copied beside its new place, compared byte for byte, moved into place, and only then
//! removed from the old folder. Nothing in a new folder is ever written over. A Workspace
//! that could not be moved stays in the old folder and is used from there (`Registry`'s
//! legacy folders); the start screen says so, and the next start tries again (a marker in
//! the new config folder says a move is under way until nothing is left to move). No Tauri
//! types.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::datadir::{self, Moved, STAGING_SUFFIX};

/// The app's identifier before the rename.
pub const OLD_IDENTIFIER: &str = "app.qoop.desktop";
/// In the new config folder while a move from the old folders is under way, or left
/// something behind: the next start goes on with it even though the new folders now hold
/// Workspaces.
const MARKER: &str = ".moving-from-app.qoop.desktop";
/// The list of Workspaces (`workspaces.rs`), and where an empty one is kept aside.
const LIST_FILE: &str = "workspaces.json";
const EMPTY_LIST_ASIDE: &str = "workspaces.json.empty-before-move";
/// The folders that `datadir::move_workspaces` moves one entry at a time.
const LOCAL_DIR: &str = "workspaces";
const MOVES_DIR: &str = "moves";

/// The folder `new` (named after the identifier `identifier`) had before the rename: the same
/// place, named after [`OLD_IDENTIFIER`]. `None` when `new` is not named after `identifier`.
pub fn old_folder(new: &Path, identifier: &str) -> Option<PathBuf> {
    (identifier != OLD_IDENTIFIER && new.file_name()? == identifier)
        .then(|| new.with_file_name(OLD_IDENTIFIER))
}

/// What moving from the old folders did.
#[derive(Debug, Default)]
pub struct Renamed {
    /// The Local Workspaces moved, and those left in an old folder (used from there).
    pub workspaces: Moved,
    /// Each old folder that still holds a Workspace that could not be moved, with its new one.
    pub left_in: Vec<(PathBuf, PathBuf)>,
    /// Anything else that stayed in an old folder: its place there.
    pub left: Vec<PathBuf>,
}

impl Renamed {
    /// What the start screen says about it, if anything.
    pub fn notice(&self) -> Option<String> {
        let (old, new) = self.left_in.first()?;
        self.workspaces.notice(old, new)
    }
}

/// Moves what each old folder of `pairs` (old, new) holds into its new folder, if the new
/// folders hold no Workspace yet or an earlier start began the move. `config` is the new
/// config folder, where the list of Workspaces is.
pub fn move_app_folders(pairs: &[(PathBuf, PathBuf)], config: &Path) -> Renamed {
    let mut result = Renamed::default();
    let mut todo: Vec<&(PathBuf, PathBuf)> = Vec::new();
    for pair in pairs {
        if pair.0 != pair.1 && pair.0.is_dir() && !todo.contains(&pair) {
            todo.push(pair);
        }
    }
    let marker = config.join(MARKER);
    if todo.is_empty() {
        let _ = fs::remove_file(&marker);
        return result;
    }
    if !marker.exists() {
        // Never two sets of Workspaces mixed: new folders already in use are left alone, and
        // so are the old ones.
        if has_workspaces(config, todo.iter().map(|(_, new)| new.as_path())) {
            return result;
        }
        // Nothing is moved unless the next start will know a move began.
        if datadir::create_private_dir(config)
            .and_then(|()| fs::write(&marker, ""))
            .is_err()
        {
            eprintln!("Infall: the folders from before the rename were not moved");
            return result;
        }
        // An empty list (a start under the new name before this one) gives way to the old
        // list; it is kept aside, not written over.
        if config.join(LIST_FILE).is_file() && !config.join(EMPTY_LIST_ASIDE).exists() {
            let _ = fs::rename(config.join(LIST_FILE), config.join(EMPTY_LIST_ASIDE));
        }
    }
    // Whether the next start should try again: a Workspace, or a file, that could not be
    // moved. What a new folder already had is not tried again: it is never written over.
    let mut again = false;
    for (old, new) in todo {
        let moved = datadir::move_workspaces(old, new);
        if !moved.left.is_empty() {
            result.left_in.push((old.clone(), new.clone()));
            again = true;
        }
        result.workspaces.moved.extend(moved.moved);
        result.workspaces.left.extend(moved.left);
        result.workspaces.stale.extend(moved.stale);
        for name in entry_names(old) {
            let (from, to) = (old.join(&name), new.join(&name));
            if name == LOCAL_DIR || name == MOVES_DIR {
                // What `move_workspaces` did not move, or moved without removing it here.
                result.left.push(from);
                continue;
            }
            if fs::symlink_metadata(&to).is_ok() {
                eprintln!(
                    "Infall: {} was not moved: {} already exists",
                    from.display(),
                    to.display()
                );
                result.left.push(from);
                continue;
            }
            match datadir::move_one(&from, &to) {
                Ok(true) => {}
                Ok(false) => eprintln!(
                    "Infall: {} was moved, but its old copy could not be removed",
                    from.display()
                ),
                Err(error) => {
                    eprintln!("Infall: {} was not moved ({error})", from.display());
                    result.left.push(from);
                    again = true;
                }
            }
        }
        let _ = fs::remove_dir(old);
    }
    if !again {
        let _ = fs::remove_file(&marker);
    }
    result
}

/// Whether the list in `config` names a Workspace, or one of `folders` holds a Local
/// Workspace's folder.
fn has_workspaces<'a>(config: &'a Path, folders: impl Iterator<Item = &'a Path>) -> bool {
    let listed = fs::read_to_string(config.join(LIST_FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .is_none_or(|value| {
            value["workspaces"]
                .as_array()
                .is_none_or(|list| !list.is_empty())
        });
    // A list that cannot be read counts as one that names Workspaces: it is not the move's
    // to judge. A missing list names none.
    let listed = listed && config.join(LIST_FILE).exists();
    listed
        || folders
            .chain(std::iter::once(config))
            .any(|folder| !entry_names(&folder.join(LOCAL_DIR)).is_empty())
}

/// Every name in `dir` but staging copies and the marker; sorted. Hidden names count.
fn entry_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n != MARKER && !(n.starts_with('.') && n.ends_with(STAGING_SUFFIX)))
        .collect();
    names.sort();
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEW: &str = "app.infall.desktop";

    struct Roots {
        _tmp: tempfile::TempDir,
        old: PathBuf,
        new: PathBuf,
    }

    /// One folder for everything, as on macOS: `<base>/app.qoop.desktop` and
    /// `<base>/app.infall.desktop`.
    fn roots() -> Roots {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("Application Support").join(OLD_IDENTIFIER);
        let new = tmp.path().join("Application Support").join(NEW);
        fs::create_dir_all(&old).unwrap();
        Roots {
            _tmp: tmp,
            old,
            new,
        }
    }

    /// The old folder as a 0.9.0 build before the rename left it.
    fn old_app(dir: &Path) {
        for (id, content) in [("aaa", "first"), ("bbb", "second")] {
            let ws = dir.join(LOCAL_DIR).join(id);
            fs::create_dir_all(ws.join("backups")).unwrap();
            fs::write(ws.join("workspace.sqlite"), content).unwrap();
            fs::write(ws.join("workspace.sqlite.secret-key"), "key").unwrap();
            fs::write(ws.join("backups/backup-2026-11-24-150405.infall"), "b").unwrap();
        }
        fs::write(
            dir.join(LIST_FILE),
            r#"{"workspaces":[{"id":"aaa","kind":"local","name":"A","preset":"blank","address":null,"lastOpened":1,"port":26000}]}"#,
        )
        .unwrap();
        fs::write(dir.join("runner.json"), r#"{"v":1}"#).unwrap();
        fs::write(
            dir.join("runner-approvals.json"),
            r#"{"v":1,"approved":[]}"#,
        )
        .unwrap();
        fs::write(dir.join("window.json"), r#"{"aaa":1.25}"#).unwrap();
        fs::write(dir.join("updates.json"), "{}").unwrap();
        fs::create_dir_all(dir.join(MOVES_DIR)).unwrap();
        fs::write(dir.join(MOVES_DIR).join("m.infall"), "move").unwrap();
        fs::create_dir_all(dir.join("EBWebView/Default/Local Storage")).unwrap();
        fs::write(dir.join("EBWebView/Default/Local Storage/leveldb"), "kv").unwrap();
    }

    fn pairs(r: &Roots) -> Vec<(PathBuf, PathBuf)> {
        // macOS: config, data and local data are the same folder.
        vec![(r.old.clone(), r.new.clone()); 3]
    }

    #[test]
    fn the_folder_named_after_the_old_identifier_is_beside_the_new_one() {
        assert_eq!(
            old_folder(Path::new("/h/.config/app.infall.desktop"), NEW),
            Some(PathBuf::from("/h/.config/app.qoop.desktop"))
        );
        assert_eq!(old_folder(Path::new("/h/.config/other"), NEW), None);
        assert_eq!(
            old_folder(Path::new("/h/app.qoop.desktop"), OLD_IDENTIFIER),
            None
        );
    }

    #[test]
    fn everything_in_the_old_folder_moves_to_the_new_one_checked() {
        let r = roots();
        old_app(&r.old);
        let renamed = move_app_folders(&pairs(&r), &r.new);
        assert_eq!(
            renamed.workspaces.moved,
            vec!["aaa".to_owned(), "bbb".to_owned()]
        );
        assert!(renamed.left.is_empty() && renamed.left_in.is_empty());
        assert!(renamed.notice().is_none());
        let n = &r.new;
        assert_eq!(
            fs::read_to_string(n.join("workspaces/aaa/workspace.sqlite")).unwrap(),
            "first"
        );
        assert_eq!(
            fs::read_to_string(n.join("workspaces/bbb/workspace.sqlite.secret-key")).unwrap(),
            "key"
        );
        assert!(
            n.join("workspaces/bbb/backups/backup-2026-11-24-150405.infall")
                .is_file()
        );
        assert!(
            fs::read_to_string(n.join(LIST_FILE))
                .unwrap()
                .contains("\"aaa\"")
        );
        for (file, text) in [
            ("runner.json", r#"{"v":1}"#),
            ("runner-approvals.json", r#"{"v":1,"approved":[]}"#),
            ("window.json", r#"{"aaa":1.25}"#),
            ("updates.json", "{}"),
            ("moves/m.infall", "move"),
            ("EBWebView/Default/Local Storage/leveldb", "kv"),
        ] {
            assert_eq!(fs::read_to_string(n.join(file)).unwrap(), text, "{file}");
        }
        // The old folder is gone, the marker too, and no staging copy is left.
        assert!(!r.old.exists());
        assert!(!n.join(MARKER).exists());
        assert!(entry_names(n).iter().all(|e| !e.ends_with(STAGING_SUFFIX)));
        // The Registry reads the moved list and finds the Workspace where it now is.
        let registry = crate::workspaces::Registry::new(n.clone(), n.clone());
        assert_eq!(registry.list().len(), 1);
        assert_eq!(
            fs::read_to_string(registry.db_path("aaa")).unwrap(),
            "first"
        );
        // A second start: nothing to do.
        let again = move_app_folders(&pairs(&r), &r.new);
        assert!(again.workspaces.moved.is_empty() && again.left.is_empty());
    }

    #[test]
    fn config_and_data_in_separate_folders_each_move_to_their_new_one() {
        // Linux: `~/.config/<id>` and `~/.local/share/<id>`.
        let tmp = tempfile::tempdir().unwrap();
        let config_old = tmp.path().join("config").join(OLD_IDENTIFIER);
        let config_new = tmp.path().join("config").join(NEW);
        let data_old = tmp.path().join("share").join(OLD_IDENTIFIER);
        let data_new = tmp.path().join("share").join(NEW);
        fs::create_dir_all(&config_old).unwrap();
        fs::write(config_old.join(LIST_FILE), r#"{"workspaces":[]}"#).unwrap();
        fs::write(config_old.join("runner.json"), "{}").unwrap();
        let ws = data_old.join(LOCAL_DIR).join("ccc");
        fs::create_dir_all(&ws).unwrap();
        fs::write(ws.join("workspace.sqlite"), "db").unwrap();
        fs::create_dir_all(data_old.join("localstorage")).unwrap();
        fs::write(
            data_old.join("localstorage/http_127.0.0.1_26000.localstorage"),
            "ls",
        )
        .unwrap();
        let pairs = vec![
            (config_old.clone(), config_new.clone()),
            (data_old.clone(), data_new.clone()),
            (data_old.clone(), data_new.clone()),
        ];
        let renamed = move_app_folders(&pairs, &config_new);
        assert_eq!(renamed.workspaces.moved, vec!["ccc".to_owned()]);
        assert!(config_new.join(LIST_FILE).is_file() && config_new.join("runner.json").is_file());
        assert!(data_new.join("workspaces/ccc/workspace.sqlite").is_file());
        assert!(
            data_new
                .join("localstorage/http_127.0.0.1_26000.localstorage")
                .is_file()
        );
        assert!(!config_old.exists() && !data_old.exists());
    }

    #[test]
    fn new_folders_that_already_hold_workspaces_and_the_old_ones_are_left_alone() {
        let r = roots();
        old_app(&r.old);
        let ws = r.new.join(LOCAL_DIR).join("zzz");
        fs::create_dir_all(&ws).unwrap();
        fs::write(ws.join("workspace.sqlite"), "new").unwrap();
        let renamed = move_app_folders(&pairs(&r), &r.new);
        assert!(renamed.workspaces.moved.is_empty());
        assert!(r.old.join("workspaces/aaa/workspace.sqlite").is_file());
        assert!(r.old.join(LIST_FILE).is_file());
        assert!(!r.new.join(LIST_FILE).exists() && !r.new.join(MARKER).exists());

        // A list that names a Workspace counts the same.
        let r = roots();
        old_app(&r.old);
        fs::create_dir_all(&r.new).unwrap();
        fs::write(
            r.new.join(LIST_FILE),
            r#"{"workspaces":[{"id":"team","kind":"team","name":"T","preset":null,"address":"https://infall.example.org","lastOpened":null}]}"#,
        )
        .unwrap();
        move_app_folders(&pairs(&r), &r.new);
        assert!(r.old.join(LIST_FILE).is_file());
        assert!(
            fs::read_to_string(r.new.join(LIST_FILE))
                .unwrap()
                .contains("team")
        );
    }

    #[test]
    fn an_empty_new_list_is_kept_aside_and_nothing_new_is_written_over() {
        let r = roots();
        old_app(&r.old);
        fs::create_dir_all(&r.new).unwrap();
        fs::write(r.new.join(LIST_FILE), r#"{"workspaces":[]}"#).unwrap();
        // The new build already wrote its own Runner settings: they stay; the old stay too.
        fs::write(r.new.join("runner.json"), r#"{"v":1,"new":true}"#).unwrap();
        let renamed = move_app_folders(&pairs(&r), &r.new);
        assert!(
            fs::read_to_string(r.new.join(LIST_FILE))
                .unwrap()
                .contains("\"aaa\"")
        );
        assert_eq!(
            fs::read_to_string(r.new.join(EMPTY_LIST_ASIDE)).unwrap(),
            r#"{"workspaces":[]}"#
        );
        assert_eq!(
            fs::read_to_string(r.new.join("runner.json")).unwrap(),
            r#"{"v":1,"new":true}"#
        );
        assert_eq!(renamed.left, vec![r.old.join("runner.json")]);
        assert_eq!(
            fs::read_to_string(r.old.join("runner.json")).unwrap(),
            r#"{"v":1}"#
        );
        // What the new folder already had is never tried again: the move is over, and the
        // old copy stays in the old folder, untouched.
        assert!(!r.new.join(MARKER).exists());
        let again = move_app_folders(&pairs(&r), &r.new);
        assert!(again.left.is_empty() && again.workspaces.moved.is_empty());
        assert_eq!(
            fs::read_to_string(r.old.join("runner.json")).unwrap(),
            r#"{"v":1}"#
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_file_that_cannot_be_moved_is_tried_again_at_the_next_start() {
        let r = roots();
        old_app(&r.old);
        // A link is not the app's to copy: `window.json` as one stays where it is.
        fs::remove_file(r.old.join("window.json")).unwrap();
        std::os::unix::fs::symlink("/etc/hosts", r.old.join("window.json")).unwrap();
        let renamed = move_app_folders(&pairs(&r), &r.new);
        assert_eq!(renamed.left, vec![r.old.join("window.json")]);
        assert!(renamed.notice().is_none());
        assert!(r.new.join(MARKER).exists());
        assert!(r.new.join("runner.json").is_file());
        fs::remove_file(r.old.join("window.json")).unwrap();
        fs::write(r.old.join("window.json"), "{}").unwrap();
        let renamed = move_app_folders(&pairs(&r), &r.new);
        assert!(renamed.left.is_empty());
        assert_eq!(fs::read_to_string(r.new.join("window.json")).unwrap(), "{}");
        assert!(!r.old.exists() && !r.new.join(MARKER).exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_workspace_that_cannot_move_is_used_from_the_old_folder_and_moved_next_time() {
        let r = roots();
        old_app(&r.old);
        // `aaa` holds a link: not the app's to copy, so its folder stays where it is.
        let link = r.old.join("workspaces/aaa/link");
        std::os::unix::fs::symlink("/etc/hosts", &link).unwrap();
        let renamed = move_app_folders(&pairs(&r), &r.new);
        assert_eq!(renamed.workspaces.moved, vec!["bbb".to_owned()]);
        assert_eq!(renamed.workspaces.left, vec!["aaa".to_owned()]);
        assert_eq!(renamed.left_in, vec![(r.old.clone(), r.new.clone())]);
        let notice = renamed.notice().unwrap();
        assert!(notice.starts_with("One workspace could not be moved to "));
        assert!(notice.contains("Nothing was lost."));
        assert!(r.old.join("workspaces/aaa/workspace.sqlite").is_file());
        // The list moved, and the Workspace that stayed is found where it is.
        let registry = crate::workspaces::Registry::with_legacy(
            r.new.clone(),
            r.new.clone(),
            vec![r.old.clone()],
        );
        assert_eq!(
            fs::read_to_string(registry.db_path("aaa")).unwrap(),
            "first"
        );
        assert_eq!(
            fs::read_to_string(registry.db_path("bbb")).unwrap(),
            "second"
        );
        // The next start, once it can be moved, moves it.
        assert!(r.new.join(MARKER).exists());
        fs::remove_file(&link).unwrap();
        let renamed = move_app_folders(&pairs(&r), &r.new);
        assert_eq!(renamed.workspaces.moved, vec!["aaa".to_owned()]);
        assert!(renamed.notice().is_none());
        assert!(r.new.join("workspaces/aaa/workspace.sqlite").is_file());
        assert!(!r.old.exists() && !r.new.join(MARKER).exists());
    }

    #[test]
    fn no_old_folder_does_nothing() {
        let r = roots();
        fs::remove_dir(&r.old).unwrap();
        let renamed = move_app_folders(&pairs(&r), &r.new);
        assert!(renamed.workspaces.moved.is_empty() && renamed.left.is_empty());
        assert!(!r.new.exists());
        // The same folder twice (an identifier that did not change) is never touched.
        let r = roots();
        old_app(&r.old);
        move_app_folders(&[(r.old.clone(), r.old.clone())], &r.old);
        assert!(r.old.join(LIST_FILE).is_file());
    }
}
