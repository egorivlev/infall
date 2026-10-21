//! Getting work out of the app and back in (docs/specs/portability.md): file names that are
//! safe on every system, writing a file whole or not at all, and the automatic backups of a
//! Local Workspace (decision 2). No Tauri types, and no server: the copy itself is made by
//! whatever the caller passes in (`qoop_server::local::export_workspace` in the app).

use std::fs;
use std::path::{Path, PathBuf};

/// The extension of a Workspace file (decision 1).
pub const WORKSPACE_EXTENSION: &str = "infall";
/// Inside a Local Workspace's folder.
pub const BACKUP_DIR: &str = "backups";
/// How many backups are kept: the newest.
pub const KEEP_BACKUPS: usize = 7;
/// A new backup is made on opening when the newest is at least this old (ms).
pub const BACKUP_EVERY_MS: i64 = 24 * 60 * 60 * 1000;

/// What `saveFile` accepts at most (Contract D).
pub const MAX_SAVE_BYTES: usize = 20 * 1024 * 1024;

const BACKUP_PREFIX: &str = "backup-";
const PARTIAL_SUFFIX: &str = ".partial";
/// Characters no file name may hold on Windows (and `/` nowhere).
const FORBIDDEN: [char; 9] = ['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
/// Names Windows keeps for devices, whatever the extension.
const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];
/// Characters a name keeps at most: far below every system's limit, however the characters
/// are encoded.
const MAX_STEM_CHARS: usize = 100;

// ---- names -------------------------------------------------------------------------------

/// `name` as the part of a file name before the extension: no path separators, nothing
/// Windows forbids, no control characters, no dots or spaces at either end (hidden on Unix,
/// dropped by Windows), not a Windows device name, not too long. `fallback` when nothing is
/// left.
pub fn safe_stem(name: &str, fallback: &str) -> String {
    let replaced: String = name
        .chars()
        .map(|c| {
            if c.is_control() || FORBIDDEN.contains(&c) {
                '-'
            } else {
                c
            }
        })
        .collect();
    let trimmed = trim_ends(&replaced);
    let mut stem: String = trimmed.chars().take(MAX_STEM_CHARS).collect();
    stem = trim_ends(&stem).to_owned();
    if stem.is_empty() || stem.chars().all(|c| c == '-') {
        stem = fallback.to_owned();
    }
    // `CON`, and `con.tar` too: Windows looks at what comes before the first dot.
    let device = stem.split('.').next().unwrap_or("").trim_end();
    if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(device)) {
        stem.insert(device.len(), '_');
    }
    stem
}

/// A whole file name suggested by a page or a person: its extension is kept when it looks
/// like one (letters and digits, a few of them), the rest is made safe by [`safe_stem`].
pub fn safe_file_name(suggested: &str, fallback: &str) -> String {
    let suggested = suggested.trim();
    if let Some((stem, extension)) = suggested.rsplit_once('.') {
        let plausible = !extension.is_empty()
            && extension.len() <= 16
            && extension.chars().all(|c| c.is_ascii_alphanumeric());
        if plausible && !trim_ends(stem).is_empty() {
            return format!("{}.{extension}", safe_stem(stem, fallback));
        }
    }
    safe_stem(suggested, fallback)
}

fn trim_ends(s: &str) -> &str {
    s.trim_matches(|c: char| c == '.' || c.is_whitespace())
}

/// The name a Workspace made from the file `stem.infall` gets, before it is made unique:
/// the file's name without its extension, made a valid Workspace name.
pub fn workspace_name_from_file(stem: &str, max_chars: usize) -> String {
    let cleaned: String = stem
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let name: String = cleaned.trim().chars().take(max_chars).collect();
    let name = name.trim();
    if name.is_empty() {
        "Imported workspace".to_owned()
    } else {
        name.to_owned()
    }
}

/// The path the person chose in a save dialog, with `.extension` added when it has none —
/// unless a file of that name is already there, which the person was never asked about.
pub fn with_extension(path: PathBuf, extension: &str) -> PathBuf {
    let has = path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case(extension));
    if has {
        return path;
    }
    let mut longer = path.clone().into_os_string();
    longer.push(".");
    longer.push(extension);
    let longer = PathBuf::from(longer);
    if longer.exists() { path } else { longer }
}

// ---- writing -----------------------------------------------------------------------------

/// Writes `dest` whole or not at all: `write` fills a new file beside it (which does not
/// exist yet), and that file then takes `dest`'s place, replacing what was there. On
/// failure nothing is left behind and `dest` is as it was.
pub fn write_replacing(
    dest: &Path,
    write: impl FnOnce(&Path) -> Result<(), String>,
    failed: &str,
) -> Result<(), String> {
    let name = dest
        .file_name()
        .ok_or_else(|| failed.to_owned())?
        .to_string_lossy()
        .into_owned();
    let mut bytes = [0u8; 6];
    getrandom::fill(&mut bytes).expect("the operating system provides random bytes");
    let tag: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let tmp = dest.with_file_name(format!(".{name}.{tag}{PARTIAL_SUFFIX}"));
    let result = write(&tmp).and_then(|()| fs::rename(&tmp, dest).map_err(|_| failed.to_owned()));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

// ---- backups -----------------------------------------------------------------------------

/// The file name of a backup made at `ms` (unix ms, UTC): `backup-2026-11-24-150405.infall`.
/// Names sort as times do.
pub fn backup_name(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (y, m, d) = civil_from_days(days);
    format!(
        "{BACKUP_PREFIX}{y:04}-{m:02}-{d:02}-{:02}{:02}{:02}.{WORKSPACE_EXTENSION}",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

/// When the backup called `name` was made (unix ms), if it is a name [`backup_name`] gives.
pub fn backup_time(name: &str) -> Option<i64> {
    let core = name
        .strip_prefix(BACKUP_PREFIX)?
        .strip_suffix(&format!(".{WORKSPACE_EXTENSION}"))?;
    let b = core.as_bytes();
    let shape = b.len() == 17
        && b[4] == b'-'
        && b[7] == b'-'
        && b[10] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| matches!(i, 4 | 7 | 10) || c.is_ascii_digit());
    if !shape {
        return None;
    }
    let n = |range: std::ops::Range<usize>| core[range].parse::<i64>().ok();
    let (y, m, d) = (n(0..4)?, n(5..7)?, n(8..10)?);
    let (h, min, s) = (n(11..13)?, n(13..15)?, n(15..17)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || h > 23 || min > 59 || s > 59 {
        return None;
    }
    let days = days_from_civil(y, m, d);
    // 31 February is not a day: it must read back as itself.
    if civil_from_days(days) != (y, m, d) {
        return None;
    }
    Some(((days * 86_400) + h * 3600 + min * 60 + s) * 1000)
}

/// The backups in `dir`, newest first: (time, path). Nothing else in the folder is ever
/// counted, kept or deleted.
pub fn backups(dir: &Path) -> Vec<(i64, PathBuf)> {
    let mut found: Vec<(i64, PathBuf)> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| Some((backup_time(e.file_name().to_str()?)?, e.path())))
        .collect();
    found.sort_by_key(|(t, _)| std::cmp::Reverse(*t));
    found
}

/// When the newest backup in `dir` was made, if there is one.
pub fn newest_backup(dir: &Path) -> Option<i64> {
    backups(dir).first().map(|(t, _)| *t)
}

/// Is a backup due at `now`: none yet, or the newest at least a day old.
pub fn backup_due(dir: &Path, now: i64) -> bool {
    newest_backup(dir).is_none_or(|t| now.saturating_sub(t) >= BACKUP_EVERY_MS)
}

/// Deletes all but the newest `keep` backups in `dir`.
pub fn rotate(dir: &Path, keep: usize) {
    for (_, path) in backups(dir).into_iter().skip(keep) {
        let _ = fs::remove_file(path);
    }
}

/// What opening a Local Workspace does about its backups (decision 2): when one is due, a
/// copy of the database at `db` is made into `dir` by `export` (which writes the file it is
/// given, one that does not exist yet), and only the newest [`KEEP_BACKUPS`] are kept.
/// Returns when the newest backup was made, after this. A failure leaves the backups that
/// were there as they were, and nothing half-written.
pub fn keep_backed_up(
    db: &Path,
    dir: &Path,
    now: i64,
    export: impl FnOnce(&Path, &Path) -> Result<(), String>,
) -> Result<Option<i64>, String> {
    if !backup_due(dir, now) {
        return Ok(newest_backup(dir));
    }
    if !db.is_file() {
        return Err(format!("there is no database at {}", db.display()));
    }
    fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    remove_partials(dir);
    let dest = dir.join(backup_name(now));
    if !dest.exists() {
        let tmp = dir.join(format!(".{}{PARTIAL_SUFFIX}", backup_name(now)));
        let _ = fs::remove_file(&tmp);
        let made = export(db, &tmp)
            .and_then(|()| fs::rename(&tmp, &dest).map_err(|e| format!("{}: {e}", dest.display())));
        if let Err(e) = made {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
    }
    rotate(dir, KEEP_BACKUPS);
    Ok(newest_backup(dir))
}

/// What a backup cut short (the app quit while making it) left behind.
fn remove_partials(dir: &Path) {
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(&format!(".{BACKUP_PREFIX}")) && name.ends_with(PARTIAL_SUFFIX) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

// Days since 1970-01-01 and back (H. Hinnant's algorithms, proleptic Gregorian calendar).

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = BACKUP_EVERY_MS;
    /// 2026-11-24 15:04:05 UTC.
    const NOW: i64 = 1_795_532_645_000;

    #[test]
    fn names_are_safe_on_every_system() {
        assert_eq!(safe_stem("Literature review", "W"), "Literature review");
        assert_eq!(
            safe_stem("a/b\\c:d*e?f\"g<h>i|j", "W"),
            "a-b-c-d-e-f-g-h-i-j"
        );
        assert_eq!(safe_stem("../../etc/passwd", "W"), "-..-etc-passwd");
        assert_eq!(safe_stem("tab\there\nnew", "W"), "tab-here-new");
        assert_eq!(safe_stem("  .hidden.  ", "W"), "hidden");
        assert_eq!(safe_stem("ends with dots...", "W"), "ends with dots");
        assert_eq!(safe_stem("", "Workspace"), "Workspace");
        assert_eq!(safe_stem(" ... ", "Workspace"), "Workspace");
        assert_eq!(safe_stem("///", "Workspace"), "Workspace");
        assert_eq!(safe_stem("Квантовые блуждания", "W"), "Квантовые блуждания");
        // Windows' device names, in any case and with an extension behind them.
        assert_eq!(safe_stem("CON", "W"), "CON_");
        assert_eq!(safe_stem("nul", "W"), "nul_");
        assert_eq!(safe_stem("Com1.notes", "W"), "Com1_.notes");
        assert_eq!(safe_stem("CONSOLE", "W"), "CONSOLE");
        assert_eq!(
            safe_stem(&"x".repeat(500), "W").chars().count(),
            MAX_STEM_CHARS
        );
        assert_eq!(
            safe_stem(&format!("{}. b", "x".repeat(99)), "W"),
            "x".repeat(99)
        );

        assert_eq!(
            safe_file_name("Random walks.md", "Untitled"),
            "Random walks.md"
        );
        assert_eq!(safe_file_name("sources.bib", "Untitled"), "sources.bib");
        assert_eq!(safe_file_name("a/b.bib", "Untitled"), "a-b.bib");
        assert_eq!(safe_file_name("CON.md", "Untitled"), "CON_.md");
        assert_eq!(safe_file_name(".md", "Untitled"), "md");
        assert_eq!(safe_file_name("", "Untitled"), "Untitled");
        assert_eq!(safe_file_name("notes.m d", "Untitled"), "notes.m d");
        assert_eq!(safe_file_name("x.md/../../y", "Untitled"), "x.md-..-..-y");
        assert_eq!(safe_file_name("report.", "Untitled"), "report");

        for name in [safe_stem("a:b", "W"), safe_file_name("<x>.bib", "U")] {
            assert!(!name.contains(FORBIDDEN), "{name}");
        }
    }

    #[test]
    fn an_imported_workspace_is_named_after_its_file() {
        assert_eq!(workspace_name_from_file("Thesis", 80), "Thesis");
        assert_eq!(workspace_name_from_file("  a\nb ", 80), "a b");
        assert_eq!(workspace_name_from_file("", 80), "Imported workspace");
        assert_eq!(workspace_name_from_file("\t", 80), "Imported workspace");
        assert_eq!(
            workspace_name_from_file(&"y".repeat(90), 80),
            "y".repeat(80)
        );
    }

    #[test]
    fn the_extension_is_added_unless_that_would_replace_an_unasked_file() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path();
        assert_eq!(
            with_extension(p.join("x.infall"), "infall"),
            p.join("x.infall")
        );
        assert_eq!(
            with_extension(p.join("x.INFALL"), "infall"),
            p.join("x.INFALL")
        );
        assert_eq!(with_extension(p.join("x"), "infall"), p.join("x.infall"));
        assert_eq!(
            with_extension(p.join("x.zip"), "infall"),
            p.join("x.zip.infall")
        );
        fs::write(p.join("y.infall"), "x").unwrap();
        assert_eq!(with_extension(p.join("y"), "infall"), p.join("y"));
    }

    #[test]
    fn a_file_is_written_whole_or_not_at_all() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("notes.md");
        write_replacing(
            &dest,
            |t| fs::write(t, "one").map_err(|e| e.to_string()),
            "no",
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), "one");
        // Replaces what is there (the dialog asked).
        write_replacing(
            &dest,
            |t| fs::write(t, "two").map_err(|e| e.to_string()),
            "no",
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), "two");
        // A failure halfway leaves the old file and nothing else.
        let failed = write_replacing(
            &dest,
            |t| {
                fs::write(t, "half").unwrap();
                Err("broke".to_owned())
            },
            "no",
        );
        assert_eq!(failed, Err("broke".to_owned()));
        assert_eq!(fs::read_to_string(&dest).unwrap(), "two");
        assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 1);
        // Into a folder that is not there.
        let gone = tmp.path().join("missing").join("x.md");
        assert!(
            write_replacing(&gone, |t| fs::write(t, "x").map_err(|_| "no".into()), "no").is_err()
        );
    }

    #[test]
    fn backup_names_read_back_as_their_time() {
        assert_eq!(backup_name(NOW), "backup-2026-11-24-150405.infall");
        assert_eq!(backup_time("backup-2026-11-24-150405.infall"), Some(NOW));
        assert_eq!(backup_name(0), "backup-1970-01-01-000000.infall");
        for t in [0, 951_782_400_000, 4_102_444_799_000, NOW + 123] {
            assert_eq!(backup_time(&backup_name(t)), Some(t - t % 1000), "{t}");
        }
        for name in [
            "backup-2026-02-31-000000.infall",
            "backup-2026-13-01-000000.infall",
            "backup-2026-11-24-250000.infall",
            "backup-2026-11-24-15040.infall",
            "backup-2026-11-24-150405.sqlite",
            "Backup-2026-11-24-150405.infall",
            "backup-2026-11-24-15040x.infall",
            "backup-+026-11-24-150405.infall",
            "notes.infall",
            ".backup-2026-11-24-150405.infall.partial",
        ] {
            assert_eq!(backup_time(name), None, "{name}");
        }
    }

    fn db(dir: &Path) -> PathBuf {
        let db = dir.join("workspace.sqlite");
        fs::write(&db, "data").unwrap();
        db
    }

    fn copy(db: &Path, dest: &Path) -> Result<(), String> {
        assert!(
            !dest.exists(),
            "the export is given a file that is not there"
        );
        fs::copy(db, dest).map(|_| ()).map_err(|e| e.to_string())
    }

    #[test]
    fn a_backup_is_made_when_none_is_and_then_once_a_day() {
        let tmp = tempfile::tempdir().unwrap();
        let db = db(tmp.path());
        let dir = tmp.path().join(BACKUP_DIR);
        assert!(backup_due(&dir, NOW));

        assert_eq!(keep_backed_up(&db, &dir, NOW, copy), Ok(Some(NOW)));
        let made = dir.join(backup_name(NOW));
        assert_eq!(fs::read_to_string(&made).unwrap(), "data");
        // Within the day: nothing new, and the export is not even asked.
        let later = NOW + DAY - 1;
        let never = |_: &Path, _: &Path| -> Result<(), String> { panic!("not due") };
        assert_eq!(keep_backed_up(&db, &dir, later, never), Ok(Some(NOW)));
        assert_eq!(backups(&dir).len(), 1);
        // A day on: another.
        assert_eq!(
            keep_backed_up(&db, &dir, NOW + DAY, copy),
            Ok(Some(NOW + DAY))
        );
        assert_eq!(backups(&dir).len(), 2);
        // A clock set back does not make one every time.
        assert!(!backup_due(&dir, NOW - 5 * DAY));
    }

    #[test]
    fn the_newest_seven_backups_are_kept_and_nothing_else_is_touched() {
        let tmp = tempfile::tempdir().unwrap();
        let db = db(tmp.path());
        let dir = tmp.path().join(BACKUP_DIR);
        fs::create_dir_all(&dir).unwrap();
        // Ten older ones, in no order, and things that are not backups.
        for i in [3, 9, 0, 5, 1, 7, 2, 8, 4, 6] {
            fs::write(dir.join(backup_name(NOW - (20 - i) * DAY)), "old").unwrap();
        }
        fs::write(dir.join("my notes.txt"), "mine").unwrap();
        fs::write(dir.join("backup-someday.infall"), "mine").unwrap();
        fs::create_dir(dir.join(backup_name(NOW - 100 * DAY))).unwrap();
        // Left by a backup the app was quit in the middle of.
        let partial = dir.join(format!(".{}.partial", backup_name(NOW - 30 * DAY)));
        fs::write(&partial, "half").unwrap();

        assert_eq!(keep_backed_up(&db, &dir, NOW, copy), Ok(Some(NOW)));
        let kept: Vec<i64> = backups(&dir).into_iter().map(|(t, _)| t).collect();
        let expected: Vec<i64> = std::iter::once(NOW)
            .chain((0..6).map(|k| NOW - (11 + k) * DAY))
            .collect();
        assert_eq!(kept, expected);
        assert!(dir.join("my notes.txt").exists());
        assert!(dir.join("backup-someday.infall").exists());
        assert!(dir.join(backup_name(NOW - 100 * DAY)).is_dir());
        assert!(!partial.exists());
    }

    #[test]
    fn a_failed_backup_keeps_what_was_there_and_leaves_nothing_half_written() {
        let tmp = tempfile::tempdir().unwrap();
        let db = db(tmp.path());
        let dir = tmp.path().join(BACKUP_DIR);
        fs::create_dir_all(&dir).unwrap();
        for k in 2..10 {
            fs::write(dir.join(backup_name(NOW - k * DAY)), "old").unwrap();
        }
        let broken = |_: &Path, dest: &Path| -> Result<(), String> {
            fs::write(dest, "half").unwrap();
            Err("the disk is full".to_owned())
        };
        assert_eq!(
            keep_backed_up(&db, &dir, NOW, broken),
            Err("the disk is full".to_owned())
        );
        // Nothing rotated away on a failure, and no partial file.
        assert_eq!(backups(&dir).len(), 8);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 8);
        // Still due: the next opening tries again.
        assert!(backup_due(&dir, NOW));

        // No database (never opened, or deleted by hand): an error, not a panic.
        let none = tmp.path().join("missing.sqlite");
        assert!(keep_backed_up(&none, &tmp.path().join("b2"), NOW, copy).is_err());
        // A folder that cannot be made.
        fs::write(tmp.path().join("file"), "x").unwrap();
        assert!(keep_backed_up(&db, &tmp.path().join("file").join(BACKUP_DIR), NOW, copy).is_err());
    }

    /// The real thing end to end: a Workspace the server made, backed up while its server
    /// runs, and a new Workspace made from that backup that the server opens.
    #[test]
    fn a_backup_of_a_running_workspace_imports_as_a_new_one() {
        use qoop_server::local::{
            LocalOptions, Preset, export_workspace, import_workspace, start_local,
        };

        let tmp = tempfile::tempdir().unwrap();
        let web = tmp.path().join("web");
        fs::create_dir_all(&web).unwrap();
        fs::write(web.join("index.html"), "<!doctype html>").unwrap();
        let registry =
            crate::workspaces::Registry::new(tmp.path().join("config"), tmp.path().join("data"));
        let entry = registry.create_local("tutorial", None).unwrap();
        let db = registry.db_path(&entry.id);
        let dir = registry.backups_dir(&entry.id);
        let options = |db: PathBuf| LocalOptions {
            db,
            web_dir: web.clone(),
            preset: Preset::Tutorial,
            member_name: "Ada".to_owned(),
            port: None,
        };
        let export = |db: &Path, dest: &Path| export_workspace(db, dest).map_err(|e| e.to_string());

        tauri::async_runtime::block_on(async {
            let server = start_local(options(db.clone())).await.unwrap();
            // Made while the server is running, off its runtime's threads.
            let (db2, dir2) = (db.clone(), dir.clone());
            let made = tauri::async_runtime::spawn_blocking(move || {
                keep_backed_up(&db2, &dir2, NOW, export)
            })
            .await
            .unwrap();
            assert_eq!(made, Ok(Some(NOW)));
            server.stop().await;
        });
        let backup = dir.join(backup_name(NOW));
        assert!(backup.is_file());

        let imported = registry
            .import_local("Tutorial", |new_db| {
                import_workspace(&backup, new_db)
                    .map(|i| i.preset.map(|p| p.id().to_owned()))
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(imported.name, "Tutorial 2");
        assert_eq!(imported.preset.as_deref(), Some("tutorial"));
        let new_db = registry.db_path(&imported.id);
        tauri::async_runtime::block_on(async {
            let server = start_local(options(new_db)).await.unwrap();
            server.stop().await;
        });

        // Something that is not a Workspace file is refused, and leaves nothing behind.
        let junk = tmp.path().join("junk.infall");
        fs::write(&junk, "not a database").unwrap();
        let refused = registry.import_local("junk", |new_db| {
            import_workspace(&junk, new_db)
                .map(|_| None)
                .map_err(|e| e.to_string())
        });
        assert!(refused.is_err());
        assert_eq!(registry.list().len(), 2);
    }
}
