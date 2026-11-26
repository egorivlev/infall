//! The database file is private to its owner (unix): created 0600 with its `-wal` and `-shm`
//! companions, and the rights of a file that is already there are left alone.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use infall_server::store::SqliteStore;

fn mode(path: &Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn beside(db: &Path, suffix: &str) -> PathBuf {
    let mut name = db.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Opens the store; creating the schema writes, so the companions exist while it is open.
fn open_and_write(db: &Path) -> SqliteStore {
    SqliteStore::open(db).unwrap()
}

#[test]
fn a_new_database_file_and_its_companions_are_owner_only() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("infall.db");
    let store = open_and_write(&db);
    assert_eq!(mode(&db), 0o600);
    for suffix in ["-wal", "-shm"] {
        let f = beside(&db, suffix);
        assert!(f.exists(), "{suffix} is there while the store is open");
        assert_eq!(mode(&f), 0o600, "{suffix}");
    }
    drop(store);
    // Opened again, by whichever command: still private.
    let _store = open_and_write(&db);
    assert_eq!(mode(&db), 0o600);
}

#[test]
fn a_stricter_file_that_is_already_there_keeps_its_rights() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("infall.db");
    drop(open_and_write(&db));
    fs::set_permissions(&db, fs::Permissions::from_mode(0o400)).unwrap();
    // Read-only for its owner: SQLite may refuse it, but the rights are not ours to change.
    let _ = SqliteStore::open(&db);
    assert_eq!(mode(&db), 0o400);
}

#[test]
fn a_wider_file_that_is_already_there_is_left_as_it_is() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("infall.db");
    drop(open_and_write(&db));
    fs::set_permissions(&db, fs::Permissions::from_mode(0o644)).unwrap();
    let _store = open_and_write(&db);
    assert_eq!(mode(&db), 0o644);
}

#[test]
fn a_missing_folder_is_still_reported_by_the_open() {
    let dir = tempfile::tempdir().unwrap();
    assert!(SqliteStore::open(&dir.path().join("none/infall.db")).is_err());
}
