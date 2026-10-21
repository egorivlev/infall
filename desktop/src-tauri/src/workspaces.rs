//! The Workspaces the app knows: every Local Workspace it made and every Team Workspace it
//! was signed in to, kept in `workspaces.json` in the app's config directory. Each Local
//! Workspace has a directory of its own in the app's data directory, holding its database
//! and the files the server keeps beside it. No Tauri types.
//!
//! Every change reads the file, changes it and writes it back whole (to a temporary file
//! first, then moved into place); the caller makes sure two changes do not overlap. A file
//! damaged by hand loses only the entries that no longer make sense; a file that is not
//! JSON at all is kept aside as `workspaces.json.damaged` before it is written over.

use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::address::parse_server_address;

const FILE: &str = "workspaces.json";
/// What an earlier version of the app kept: one server address.
const OLD_FILE: &str = "config.json";
/// The id given to the Team Workspace made from an earlier version's address.
const MIGRATED_ID: &str = "earlier-server";
/// In the data directory: one directory per Local Workspace, named by its id.
const LOCAL_DIR: &str = "workspaces";
const DB_FILE: &str = "workspace.sqlite";
const MAX_NAME_CHARS: usize = 80;

/// The Presets a Local Workspace can be made from: id (Contract A) and the name a new
/// Workspace gets when none is given.
pub const PRESETS: [(&str, &str); 4] = [
    ("tutorial", "Tutorial"),
    ("blank", "Blank"),
    ("literature-review", "Literature review"),
    ("research-project", "Research project"),
];

fn preset_name(id: &str) -> Option<&'static str> {
    PRESETS
        .iter()
        .find(|(p, _)| *p == id)
        .map(|(_, name)| *name)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Local,
    Team,
}

/// One Workspace, as the list keeps it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub kind: Kind,
    pub name: String,
    /// Local: the Preset it was made from.
    pub preset: Option<String>,
    /// Team: the server origin.
    pub address: Option<String>,
    /// Unix milliseconds.
    pub last_opened: Option<i64>,
    /// Local: the port its server asks for at every start, so its address (and what the
    /// web UI keeps in the browser's storage for that address) stays the same. Not shown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// Local: when the newest backup in its folder was made (unix ms), as last seen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_backup: Option<i64>,
}

/// One Workspace, as the start screen gets it (Contract C's `WorkspaceEntry`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    pub id: String,
    pub kind: Kind,
    pub name: String,
    pub preset: Option<String>,
    pub address: Option<String>,
    pub last_opened: Option<i64>,
    /// Local only (docs/specs/portability.md, Contract C).
    pub last_backup: Option<i64>,
}

impl Entry {
    pub fn listed(&self) -> Listed {
        Listed {
            id: self.id.clone(),
            kind: self.kind,
            name: self.name.clone(),
            preset: self.preset.clone(),
            address: self.address.clone(),
            last_opened: self.last_opened,
            last_backup: self.last_backup,
        }
    }

    /// What Run approvals are remembered under: a Team Workspace's origin (as before
    /// Workspaces existed), a Local Workspace's id, whose address may change.
    pub fn approvals_key(&self) -> String {
        match (self.kind, &self.address) {
            (Kind::Team, Some(origin)) => origin.clone(),
            _ => format!("local:{}", self.id),
        }
    }

    /// How the approval window names the Workspace, under "From server": a Team
    /// Workspace's server, a Local Workspace's name.
    pub fn approvals_name(&self) -> String {
        match (self.kind, &self.address) {
            (Kind::Team, Some(origin)) => origin.clone(),
            _ => format!("{} (on this computer)", self.name),
        }
    }
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    workspaces: Vec<Entry>,
    /// The Workspace to open as soon as the app starts, once: set just before the app
    /// restarts itself to open it.
    open_next: Option<String>,
}

pub struct Registry {
    config: PathBuf,
    data: PathBuf,
}

impl Registry {
    pub fn new(config: PathBuf, data: PathBuf) -> Registry {
        Registry { config, data }
    }

    /// Every Workspace, the one opened most recently first; those never opened last.
    pub fn list(&self) -> Vec<Entry> {
        let mut list = self.load().workspaces;
        // Stable: equals keep the file's order, where the newest is first.
        list.sort_by_key(|e| std::cmp::Reverse(e.last_opened.map_or(i64::MIN, |t| t)));
        list
    }

    pub fn get(&self, id: &str) -> Option<Entry> {
        self.load().workspaces.into_iter().find(|e| e.id == id)
    }

    /// Makes a Local Workspace: its entry and its (empty) directory. Without a name it is
    /// called after its Preset, made unique ("Tutorial", "Tutorial 2").
    pub fn create_local(&self, preset: &str, name: Option<&str>) -> Result<Entry, String> {
        let default = preset_name(preset).ok_or("There is no such kind of workspace.")?;
        let name = name.map(clean_name).transpose()?;
        self.update(|stored| {
            let name = name.unwrap_or_else(|| unique_name(&stored.workspaces, default));
            let entry = Entry {
                id: new_id(),
                kind: Kind::Local,
                name,
                preset: Some(preset.to_owned()),
                address: None,
                last_opened: None,
                port: choose_port(&ports_in_use(&stored.workspaces, ""), candidates()),
                last_backup: None,
            };
            create_private_dir(&self.local_dir(&entry.id))
                .map_err(|_| "The workspace could not be made on this computer.".to_owned())?;
            stored.workspaces.insert(0, entry.clone());
            Ok(entry)
        })
    }

    /// Remembers a Team Workspace by its server origin (as `parse_server_address` returns
    /// it); the same address is remembered once. Its name is the address's host.
    pub fn remember_team(&self, origin: &str) -> Result<Entry, String> {
        let origin = parse_server_address(origin)?;
        self.update(|stored| {
            if let Some(entry) = stored
                .workspaces
                .iter()
                .find(|e| e.address.as_deref() == Some(origin.as_str()))
            {
                return Ok(entry.clone());
            }
            let entry = Entry {
                id: new_id(),
                kind: Kind::Team,
                name: host_name(&origin),
                preset: None,
                address: Some(origin.clone()),
                last_opened: None,
                port: None,
                last_backup: None,
            };
            stored.workspaces.insert(0, entry.clone());
            Ok(entry)
        })
    }

    /// Makes a Local Workspace from a Workspace file (Contract C's `workspace_import`): its
    /// entry, named after the file (`stem`, its name without the extension) made unique, and
    /// its directory, into which `import` copies the file's database (it is given where the
    /// database goes, and returns the Preset id the file was made from, if any). When
    /// `import` fails, nothing is kept: no entry, no directory.
    pub fn import_local(
        &self,
        stem: &str,
        import: impl FnOnce(&Path) -> Result<Option<String>, String>,
    ) -> Result<Entry, String> {
        let base = crate::portable::workspace_name_from_file(stem, MAX_NAME_CHARS);
        self.update(|stored| {
            let mut entry = Entry {
                id: new_id(),
                kind: Kind::Local,
                name: unique_name(&stored.workspaces, &base),
                preset: None,
                address: None,
                last_opened: None,
                port: choose_port(&ports_in_use(&stored.workspaces, ""), candidates()),
                last_backup: None,
            };
            let dir = self.local_dir(&entry.id);
            create_private_dir(&dir)
                .map_err(|_| "The workspace could not be made on this computer.".to_owned())?;
            match import(&self.db_path(&entry.id)) {
                Ok(preset) => entry.preset = preset.filter(|p| preset_name(p).is_some()),
                Err(message) => {
                    let _ = fs::remove_dir_all(&dir);
                    return Err(message);
                }
            }
            stored.workspaces.insert(0, entry.clone());
            Ok(entry)
        })
    }

    /// Notes when the newest backup of a Local Workspace was made.
    pub fn set_last_backup(&self, id: &str, at: Option<i64>) -> Result<(), String> {
        self.update(|stored| {
            let entry = find(stored, id)?;
            if entry.kind == Kind::Local {
                entry.last_backup = at.filter(|t| *t >= 0);
            }
            Ok(())
        })
    }

    pub fn rename(&self, id: &str, name: &str) -> Result<(), String> {
        let name = clean_name(name)?;
        self.update(|stored| {
            find(stored, id)?.name = name;
            Ok(())
        })
    }

    /// Forgets a Workspace. A Local Workspace's files are deleted for good first; if that
    /// fails, it stays in the list. The caller makes sure it is not open.
    pub fn remove(&self, id: &str) -> Result<(), String> {
        self.update(|stored| {
            let entry = find(stored, id)?;
            if entry.kind == Kind::Local {
                match fs::remove_dir_all(self.local_dir(id)) {
                    Ok(()) => {}
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                    Err(_) => {
                        return Err("The workspace's files could not be deleted.".to_owned());
                    }
                }
            }
            stored.workspaces.retain(|e| e.id != id);
            if stored.open_next.as_deref() == Some(id) {
                stored.open_next = None;
            }
            Ok(())
        })
    }

    /// Notes that the Workspace was opened at `now` (unix ms).
    pub fn opened(&self, id: &str, now: i64) -> Result<(), String> {
        self.update(|stored| {
            find(stored, id)?.last_opened = Some(now);
            Ok(())
        })
    }

    /// Asks for the Workspace to be opened when the app next starts.
    pub fn set_open_next(&self, id: &str) -> Result<(), String> {
        self.update(|stored| {
            find(stored, id)?;
            stored.open_next = Some(id.to_owned());
            Ok(())
        })
    }

    /// The Workspace asked for by [`Registry::set_open_next`], if any. Asked once: it is
    /// forgotten here, so that a Workspace that fails to open cannot do so at every start.
    pub fn take_open_next(&self) -> Option<Entry> {
        let mut next = None;
        let _ = self.update(|stored| {
            let id = stored.open_next.take();
            next = id.and_then(|id| stored.workspaces.iter().find(|e| e.id == id).cloned());
            Ok(())
        });
        next
    }

    /// The port a Local Workspace's server asks for. An entry without one (made by an
    /// earlier version, or whose port clashed with another entry's) is given one now: a
    /// port that is free at this moment and that no other entry has.
    pub fn port_for(&self, id: &str) -> Result<Option<u16>, String> {
        self.update(|stored| {
            let in_use = ports_in_use(&stored.workspaces, id);
            let entry = find(stored, id)?;
            if entry.kind != Kind::Local {
                return Ok(None);
            }
            if entry.port.is_none() {
                entry.port = choose_port(&in_use, candidates());
            }
            Ok(entry.port)
        })
    }

    /// Where a Local Workspace's database is (its directory is made with the entry).
    pub fn db_path(&self, id: &str) -> PathBuf {
        self.local_dir(id).join(DB_FILE)
    }

    /// Where its automatic backups are kept (docs/specs/portability.md, decision 2): inside
    /// its directory, so removing the Workspace removes them with it.
    pub fn backups_dir(&self, id: &str) -> PathBuf {
        self.local_dir(id).join(crate::portable::BACKUP_DIR)
    }

    /// A Local Workspace's directory: its database, the files the server keeps beside it,
    /// and its backups. What the start screen shows in the file manager.
    pub fn local_dir(&self, id: &str) -> PathBuf {
        // Ids are checked when read (`valid_id`), so this stays inside the data directory.
        self.data.join(LOCAL_DIR).join(id)
    }

    fn load(&self) -> Stored {
        match self.read() {
            Read::Missing => self.migrate(),
            Read::Damaged => Stored::default(),
            Read::Parsed(stored) => stored,
        }
    }

    fn read(&self) -> Read {
        match fs::read_to_string(self.config.join(FILE)) {
            Ok(text) => parse(&text),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Read::Missing,
            Err(_) => Read::Damaged,
        }
    }

    /// The address an earlier version saved becomes a Team Workspace, kept straight away
    /// so its id stays the same.
    fn migrate(&self) -> Stored {
        let mut stored = Stored::default();
        let old = fs::read_to_string(self.config.join(OLD_FILE)).ok();
        let address = old
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|v| v.get("server")?.as_str().map(str::to_owned))
            .and_then(|s| parse_server_address(&s).ok());
        if let Some(origin) = address {
            stored.workspaces.push(Entry {
                id: MIGRATED_ID.to_owned(),
                kind: Kind::Team,
                name: host_name(&origin),
                preset: None,
                address: Some(origin),
                last_opened: None,
                port: None,
                last_backup: None,
            });
            let _ = self.save(&stored);
        }
        stored
    }

    fn update<T>(
        &self,
        change: impl FnOnce(&mut Stored) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut stored = match self.read() {
            Read::Missing => self.migrate(),
            Read::Damaged => {
                // Kept for whoever damaged it; the list starts again.
                let path = self.config.join(FILE);
                let _ = fs::rename(&path, path.with_extension("json.damaged"));
                Stored::default()
            }
            Read::Parsed(stored) => stored,
        };
        let result = change(&mut stored)?;
        self.save(&stored)
            .map_err(|_| "The list of workspaces could not be saved on this computer.")?;
        Ok(result)
    }

    fn save(&self, stored: &Stored) -> io::Result<()> {
        fs::create_dir_all(&self.config)?;
        let text = serde_json::to_string_pretty(stored)?;
        let tmp = self.config.join(format!("{FILE}.tmp"));
        let mut file = fs::File::create(&tmp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(tmp, self.config.join(FILE))
    }
}

enum Read {
    Missing,
    Damaged,
    Parsed(Stored),
}

/// Reads what makes sense and drops the rest, entry by entry.
fn parse(text: &str) -> Read {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return Read::Damaged;
    };
    let Some(object) = value.as_object() else {
        return Read::Damaged;
    };
    let mut stored = Stored::default();
    let items = object.get("workspaces").and_then(Value::as_array);
    for item in items.into_iter().flatten() {
        let entry = serde_json::from_value::<Entry>(item.clone())
            .ok()
            .and_then(valid);
        if let Some(mut entry) = entry
            && !stored.workspaces.iter().any(|e| e.id == entry.id)
        {
            // Two entries never share a port: the later one is given another when opened.
            if entry.port.is_some() && stored.workspaces.iter().any(|e| e.port == entry.port) {
                entry.port = None;
            }
            stored.workspaces.push(entry);
        }
    }
    stored.open_next = object
        .get("openNext")
        .and_then(Value::as_str)
        .filter(|id| stored.workspaces.iter().any(|e| e.id == *id))
        .map(str::to_owned);
    Read::Parsed(stored)
}

fn valid(mut entry: Entry) -> Option<Entry> {
    if !valid_id(&entry.id) {
        return None;
    }
    entry.name = clean_name(&entry.name).ok()?;
    entry.last_opened = entry.last_opened.filter(|t| *t >= 0);
    entry.last_backup = entry
        .last_backup
        .filter(|t| *t >= 0 && entry.kind == Kind::Local);
    entry.port = entry
        .port
        .filter(|p| *p >= MIN_PORT && entry.kind == Kind::Local);
    match entry.kind {
        Kind::Local => {
            // Its files are still there whatever the Preset says: keep it, without one.
            entry.preset = entry.preset.filter(|p| preset_name(p).is_some());
            entry.address = None;
        }
        Kind::Team => {
            entry.address = Some(parse_server_address(entry.address.as_deref()?).ok()?);
            entry.preset = None;
        }
    }
    Some(entry)
}

/// An id is also a directory name: lowercase letters, digits and `-` only.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn find<'a>(stored: &'a mut Stored, id: &str) -> Result<&'a mut Entry, String> {
    stored
        .workspaces
        .iter_mut()
        .find(|e| e.id == id)
        .ok_or_else(|| "That workspace is no longer in the list.".to_owned())
}

fn clean_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty()
        || name.chars().count() > MAX_NAME_CHARS
        || name.chars().any(char::is_control)
    {
        return Err(format!(
            "A workspace name must be 1 to {MAX_NAME_CHARS} characters."
        ));
    }
    Ok(name.to_owned())
}

fn unique_name(list: &[Entry], base: &str) -> String {
    let taken = |name: &str| list.iter().any(|e| e.name == name);
    if !taken(base) {
        return base.to_owned();
    }
    (2..)
        .map(|n| format!("{base} {n}"))
        .find(|name| !taken(name))
        .expect("some number is free")
}

/// The host of an origin, with its port when it has one (`localhost:8787`).
fn host_name(origin: &str) -> String {
    let rest = origin.split_once("://").map_or(origin, |(_, rest)| rest);
    rest.to_owned()
}

/// Ports a Local Workspace may be given: above the well-known and below every system's
/// range for outgoing connections (Linux starts at 32768; macOS and Windows at 49152), so a
/// remembered port is seldom taken by chance.
const MIN_PORT: u16 = 20000;
const MAX_PORT: u16 = 32000;

/// The ports other entries than `except` (an id) have.
fn ports_in_use(list: &[Entry], except: &str) -> Vec<u16> {
    list.iter()
        .filter(|e| e.id != except)
        .filter_map(|e| e.port)
        .collect()
}

/// Random ports in the range, a few dozen of them.
fn candidates() -> impl Iterator<Item = u16> {
    (0..64).map(|_| {
        let mut bytes = [0u8; 2];
        getrandom::fill(&mut bytes).expect("the operating system provides random bytes");
        MIN_PORT + u16::from_le_bytes(bytes) % (MAX_PORT - MIN_PORT)
    })
}

/// The first candidate that no entry has and that can be listened on now. `None` when
/// none is: the server then gets a port from the OS at each start, and another is tried
/// at the next open.
fn choose_port(in_use: &[u16], candidates: impl Iterator<Item = u16>) -> Option<u16> {
    candidates
        .filter(|p| *p >= MIN_PORT && !in_use.contains(p))
        .find(|p| std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, *p)).is_ok())
}

fn new_id() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("the operating system provides random bytes");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A directory only the owner can open (where the platform has such modes).
fn create_private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// The name of a new Local Workspace's one Member: the operating system's user name, or
/// `Me` when there is none that can be used.
pub fn member_name() -> String {
    let var = if cfg!(windows) { "USERNAME" } else { "USER" };
    let user = std::env::var(var)
        .ok()
        .or_else(|| std::env::var("LOGNAME").ok());
    member_name_from(user.as_deref())
}

fn member_name_from(user: Option<&str>) -> String {
    match user.map(str::trim) {
        Some(name)
            if !name.is_empty()
                && name.chars().count() <= 100
                && !name.chars().any(char::is_control) =>
        {
            name.to_owned()
        }
        _ => "Me".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dirs {
        _tmp: tempfile::TempDir,
        config: PathBuf,
        data: PathBuf,
    }

    fn dirs() -> Dirs {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let data = tmp.path().join("data");
        Dirs {
            _tmp: tmp,
            config,
            data,
        }
    }

    fn registry(d: &Dirs) -> Registry {
        Registry::new(d.config.clone(), d.data.clone())
    }

    #[test]
    fn an_empty_start() {
        let d = dirs();
        assert!(registry(&d).list().is_empty());
        assert!(registry(&d).take_open_next().is_none());
    }

    #[test]
    fn local_workspaces_are_named_after_their_preset_made_unique() {
        let d = dirs();
        let r = registry(&d);
        let a = r.create_local("tutorial", None).unwrap();
        let b = r.create_local("tutorial", None).unwrap();
        let c = r
            .create_local("literature-review", Some("  My reading "))
            .unwrap();
        let e = r.create_local("blank", None).unwrap();
        assert_eq!(a.name, "Tutorial");
        assert_eq!(b.name, "Tutorial 2");
        assert_eq!(c.name, "My reading");
        assert_eq!(e.name, "Blank");
        assert_eq!(a.kind, Kind::Local);
        assert_eq!(a.preset.as_deref(), Some("tutorial"));
        assert_eq!(a.address, None);
        assert_ne!(a.id, b.id);
        assert!(r.db_path(&a.id).parent().unwrap().is_dir());
        assert!(r.db_path(&a.id).starts_with(&d.data));
        assert!(!d.config.join("workspaces.json.tmp").exists());

        assert_eq!(
            r.create_local("nonsense", None),
            Err("There is no such kind of workspace.".to_owned())
        );
        assert!(r.create_local("blank", Some("   ")).is_err());
        assert!(r.create_local("blank", Some(&"x".repeat(81))).is_err());
        assert!(r.create_local("blank", Some("a\nb")).is_err());
        assert_eq!(r.list().len(), 4);
    }

    #[test]
    fn newest_first_and_never_opened_last() {
        let d = dirs();
        let r = registry(&d);
        let a = r.create_local("blank", None).unwrap();
        let b = r.create_local("blank", None).unwrap();
        let c = r.create_local("blank", None).unwrap();
        r.opened(&a.id, 2000).unwrap();
        r.opened(&b.id, 1000).unwrap();
        let ids: Vec<_> = r.list().into_iter().map(|e| e.id).collect();
        assert_eq!(ids, [a.id.clone(), b.id, c.id]);
        assert_eq!(r.get(&a.id).unwrap().last_opened, Some(2000));
    }

    #[test]
    fn the_entry_reads_as_the_start_screen_expects() {
        let entry = Entry {
            id: "x".into(),
            kind: Kind::Local,
            name: "Tutorial".into(),
            preset: Some("tutorial".into()),
            address: None,
            last_opened: Some(5),
            port: Some(24680),
            last_backup: Some(7),
        };
        // The start screen does not see the port.
        assert_eq!(
            serde_json::to_value(entry.listed()).unwrap(),
            serde_json::json!({"id":"x","kind":"local","name":"Tutorial","preset":"tutorial","address":null,"lastOpened":5,"lastBackup":7})
        );
        let never = Entry {
            last_backup: None,
            ..entry.clone()
        };
        assert_eq!(
            serde_json::to_value(never.listed()).unwrap()["lastBackup"],
            serde_json::Value::Null
        );
        // The list keeps it.
        assert_eq!(serde_json::to_value(&entry).unwrap()["port"], 24680);
    }

    #[test]
    fn each_local_workspace_has_a_port_of_its_own_and_keeps_it() {
        let d = dirs();
        let r = registry(&d);
        let a = r.create_local("tutorial", None).unwrap();
        let b = r.create_local("blank", None).unwrap();
        let team = r.remember_team("https://qoop.example.org").unwrap();
        let pa = a.port.expect("a port is chosen when the Workspace is made");
        let pb = b.port.unwrap();
        assert_ne!(pa, pb);
        assert!((MIN_PORT..MAX_PORT).contains(&pa));
        assert_eq!(team.port, None);
        // The same at every start, in another run of the app too.
        assert_eq!(registry(&d).port_for(&a.id), Ok(Some(pa)));
        assert_eq!(registry(&d).port_for(&a.id), Ok(Some(pa)));
        assert_eq!(r.port_for(&team.id), Ok(None));
        assert!(r.port_for("missing").is_err());
    }

    #[test]
    fn an_entry_without_a_port_or_sharing_one_is_given_its_own() {
        let d = dirs();
        fs::create_dir_all(&d.config).unwrap();
        let text = r#"{"workspaces":[
            {"id":"old","kind":"local","name":"Old","preset":"blank","address":null,"lastOpened":null},
            {"id":"first","kind":"local","name":"First","preset":"blank","address":null,"lastOpened":null,"port":25000},
            {"id":"second","kind":"local","name":"Second","preset":"blank","address":null,"lastOpened":null,"port":25000},
            {"id":"low","kind":"local","name":"Low","preset":"blank","address":null,"lastOpened":null,"port":80},
            {"id":"team","kind":"team","name":"T","preset":null,"address":"https://qoop.example.org","lastOpened":null,"port":26000}
        ]}"#;
        fs::write(d.config.join("workspaces.json"), text).unwrap();
        let r = registry(&d);
        assert_eq!(r.get("first").unwrap().port, Some(25000));
        assert_eq!(r.get("second").unwrap().port, None);
        assert_eq!(r.get("low").unwrap().port, None);
        assert_eq!(r.get("team").unwrap().port, None);
        let mut ports = vec![25000];
        for id in ["old", "second", "low"] {
            let port = r.port_for(id).unwrap().unwrap();
            assert!(!ports.contains(&port), "{id} got {port} again");
            ports.push(port);
            assert_eq!(r.get(id).unwrap().port, Some(port));
        }
    }

    #[test]
    fn a_port_taken_now_or_by_another_entry_is_not_chosen() {
        let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let busy = held.local_addr().unwrap().port();
        // Candidates in order: one below the range, one another entry has, one held by
        // this test (when it is in the range), then a free one.
        let free = loop {
            let p = candidates().next().unwrap();
            if p != busy && p != 21000 && std::net::TcpListener::bind(("127.0.0.1", p)).is_ok() {
                break p;
            }
        };
        let chosen = choose_port(&[21000], [80, 21000, busy, free].into_iter());
        assert_eq!(chosen, Some(free));
        assert_eq!(choose_port(&[21000], [21000].into_iter()), None);
    }

    #[test]
    fn approvals_are_keyed_by_workspace_and_name_it() {
        let d = dirs();
        let r = registry(&d);
        let local = r.create_local("tutorial", None).unwrap();
        let team = r.remember_team("https://qoop.example.org").unwrap();
        assert_eq!(local.approvals_key(), format!("local:{}", local.id));
        assert_eq!(local.approvals_name(), "Tutorial (on this computer)");
        // A Team Workspace keeps the key approvals had before: its origin.
        assert_eq!(team.approvals_key(), "https://qoop.example.org");
        assert_eq!(team.approvals_name(), "https://qoop.example.org");
    }

    #[test]
    fn team_workspaces_are_remembered_once_by_address() {
        let d = dirs();
        let r = registry(&d);
        let a = r.remember_team("https://qoop.example.org/").unwrap();
        assert_eq!(a.kind, Kind::Team);
        assert_eq!(a.name, "qoop.example.org");
        assert_eq!(a.address.as_deref(), Some("https://qoop.example.org"));
        assert_eq!(a.preset, None);
        let again = r.remember_team("HTTPS://qoop.example.org").unwrap();
        assert_eq!(again.id, a.id);
        let local = r.remember_team("http://localhost:8787").unwrap();
        assert_eq!(local.name, "localhost:8787");
        assert_eq!(r.list().len(), 2);
        assert!(r.remember_team("http://evil.example").is_err());
    }

    #[test]
    fn the_last_backup_is_kept_in_the_list() {
        let d = dirs();
        let r = registry(&d);
        let local = r.create_local("blank", None).unwrap();
        let team = r.remember_team("https://qoop.example.org").unwrap();
        assert_eq!(local.last_backup, None);
        r.set_last_backup(&local.id, Some(1_795_532_645_000))
            .unwrap();
        // A Team Workspace has no backups here.
        r.set_last_backup(&team.id, Some(5)).unwrap();
        assert!(r.set_last_backup("missing", Some(5)).is_err());
        // Read back by another run of the app.
        let again = registry(&d);
        assert_eq!(
            again.get(&local.id).unwrap().last_backup,
            Some(1_795_532_645_000)
        );
        assert_eq!(again.get(&team.id).unwrap().last_backup, None);
        let listed: Vec<_> = again.list().iter().map(Entry::listed).collect();
        let local_listed = listed.iter().find(|l| l.id == local.id).unwrap();
        assert_eq!(local_listed.last_backup, Some(1_795_532_645_000));
        // Every other field survives the round trip too.
        let mut expected = local.clone();
        expected.last_backup = Some(1_795_532_645_000);
        assert_eq!(again.get(&local.id).unwrap(), expected);
        r.set_last_backup(&local.id, None).unwrap();
        assert_eq!(registry(&d).get(&local.id).unwrap().last_backup, None);

        // Nonsense written by hand is dropped, the entry kept.
        fs::write(
            d.config.join("workspaces.json"),
            r#"{"workspaces":[
                {"id":"a","kind":"local","name":"A","preset":"blank","address":null,"lastOpened":null,"lastBackup":-3},
                {"id":"b","kind":"team","name":"B","preset":null,"address":"https://qoop.example.org","lastOpened":null,"lastBackup":9},
                {"id":"c","kind":"local","name":"C","preset":"blank","address":null,"lastOpened":null,"lastBackup":"soon"}
            ]}"#,
        )
        .unwrap();
        let r = registry(&d);
        assert_eq!(r.get("a").unwrap().last_backup, None);
        assert_eq!(r.get("b").unwrap().last_backup, None);
        assert!(r.get("c").is_none());
    }

    #[test]
    fn the_backups_are_inside_the_workspaces_folder() {
        let d = dirs();
        let r = registry(&d);
        let a = r.create_local("blank", None).unwrap();
        assert_eq!(r.backups_dir(&a.id), r.local_dir(&a.id).join("backups"));
        assert_eq!(r.db_path(&a.id).parent().unwrap(), r.local_dir(&a.id));
    }

    #[test]
    fn an_imported_workspace_is_named_after_its_file_made_unique() {
        let d = dirs();
        let r = registry(&d);
        r.create_local("blank", Some("Thesis")).unwrap();
        let copy = |db: &Path| -> Result<Option<String>, String> {
            fs::write(db, "imported").unwrap();
            Ok(Some("literature-review".to_owned()))
        };
        let a = r.import_local("Thesis", copy).unwrap();
        let b = r.import_local("Thesis", copy).unwrap();
        let c = r.import_local("Field notes", |_| Ok(None)).unwrap();
        let e = r
            .import_local("", |_| Ok(Some("chess".to_owned())))
            .unwrap();
        assert_eq!(a.name, "Thesis 2");
        assert_eq!(b.name, "Thesis 3");
        assert_eq!(c.name, "Field notes");
        assert_eq!(e.name, "Imported workspace");
        assert_eq!(a.kind, Kind::Local);
        assert_eq!(a.preset.as_deref(), Some("literature-review"));
        assert_eq!(c.preset, None);
        // A Preset this version does not know is not kept.
        assert_eq!(e.preset, None);
        assert!(a.port.is_some());
        assert_ne!(a.port, b.port);
        assert_eq!(fs::read_to_string(r.db_path(&a.id)).unwrap(), "imported");
        assert_eq!(r.list()[0].id, e.id);
        assert_eq!(r.list().len(), 5);
        // The import was given a path inside the new Workspace's own directory.
        let mut given = None;
        let f = r
            .import_local("Where", |db| {
                given = Some(db.to_owned());
                Ok(None)
            })
            .unwrap();
        assert_eq!(given, Some(r.db_path(&f.id)));
    }

    #[test]
    fn a_database_called_workspace_is_imported_as_a_recovered_workspace_made_unique() {
        let d = dirs();
        let r = registry(&d);
        let a = r.import_local("workspace", |_| Ok(None)).unwrap();
        let b = r.import_local("workspace", |_| Ok(None)).unwrap();
        let c = r.import_local("Workspace", |_| Ok(None)).unwrap();
        let e = r.import_local("Thesis backup", |_| Ok(None)).unwrap();
        assert_eq!(a.name, "Recovered workspace");
        assert_eq!(b.name, "Recovered workspace 2");
        assert_eq!(c.name, "Recovered workspace 3");
        assert_eq!(e.name, "Thesis backup");
    }

    #[test]
    fn a_failed_import_leaves_nothing_behind() {
        let d = dirs();
        let r = registry(&d);
        let mut dir = None;
        let failed = r.import_local("Broken", |db| {
            dir = db.parent().map(Path::to_owned);
            fs::write(db, "half").unwrap();
            Err("This is not a Workspace file.".to_owned())
        });
        assert_eq!(failed, Err("This is not a Workspace file.".to_owned()));
        assert!(r.list().is_empty());
        assert!(!dir.unwrap().exists());
        // And the name is free for the next try.
        assert_eq!(
            r.import_local("Broken", |_| Ok(None)).unwrap().name,
            "Broken"
        );
    }

    #[test]
    fn renamed() {
        let d = dirs();
        let r = registry(&d);
        let a = r.create_local("blank", None).unwrap();
        r.rename(&a.id, " Notes ").unwrap();
        assert_eq!(r.get(&a.id).unwrap().name, "Notes");
        assert!(r.rename(&a.id, "").is_err());
        assert_eq!(
            r.rename("missing", "x"),
            Err("That workspace is no longer in the list.".to_owned())
        );
    }

    #[test]
    fn removing_a_local_workspace_deletes_its_files() {
        let d = dirs();
        let r = registry(&d);
        let a = r.create_local("blank", None).unwrap();
        let b = r.create_local("blank", None).unwrap();
        let db = r.db_path(&a.id);
        for file in [
            "workspace.sqlite",
            "workspace.sqlite-wal",
            "workspace.sqlite-shm",
            "secret.key",
        ] {
            fs::write(db.with_file_name(file), "x").unwrap();
        }
        // The server keeps its secret key beside the database: inside the directory that
        // removing deletes.
        let key = qoop_server::local::secret_key_path(&db);
        assert_eq!(key.parent(), db.parent());
        fs::write(&key, "x").unwrap();
        // Its backups go with it.
        let backups = r.backups_dir(&a.id);
        fs::create_dir_all(&backups).unwrap();
        fs::write(backups.join(crate::portable::backup_name(0)), "x").unwrap();
        r.remove(&a.id).unwrap();
        assert!(!backups.exists());
        assert!(!db.parent().unwrap().exists());
        assert!(!key.exists());
        assert!(r.get(&a.id).is_none());
        assert!(r.db_path(&b.id).parent().unwrap().is_dir());
        // A directory already gone is no reason to keep the entry.
        fs::remove_dir_all(r.db_path(&b.id).parent().unwrap()).unwrap();
        r.remove(&b.id).unwrap();
        assert!(r.list().is_empty());
    }

    #[test]
    fn removing_a_team_workspace_only_forgets_it() {
        let d = dirs();
        let r = registry(&d);
        let local = r.create_local("blank", None).unwrap();
        let team = r.remember_team("https://qoop.example.org").unwrap();
        r.remove(&team.id).unwrap();
        assert_eq!(r.list().len(), 1);
        assert!(r.db_path(&local.id).parent().unwrap().is_dir());
    }

    #[test]
    fn open_next_is_asked_once() {
        let d = dirs();
        let r = registry(&d);
        let a = r.create_local("tutorial", None).unwrap();
        r.set_open_next(&a.id).unwrap();
        // Another Registry on the same directories: what the restarted app sees.
        let after_restart = registry(&d);
        assert_eq!(
            after_restart.take_open_next().map(|e| e.id),
            Some(a.id.clone())
        );
        assert!(after_restart.take_open_next().is_none());
        assert!(r.set_open_next("missing").is_err());
        // Removing the Workspace forgets it as the next one too.
        r.set_open_next(&a.id).unwrap();
        r.remove(&a.id).unwrap();
        assert!(r.take_open_next().is_none());
    }

    #[test]
    fn an_earlier_versions_address_becomes_a_team_workspace() {
        let d = dirs();
        fs::create_dir_all(&d.config).unwrap();
        fs::write(
            d.config.join("config.json"),
            r#"{"server":"https://qoop.example.org"}"#,
        )
        .unwrap();
        let list = registry(&d).list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].kind, Kind::Team);
        assert_eq!(list[0].address.as_deref(), Some("https://qoop.example.org"));
        assert_eq!(list[0].name, "qoop.example.org");
        // Kept: the same id every time, and removing it does not bring it back.
        assert!(d.config.join("workspaces.json").exists());
        let id = list[0].id.clone();
        assert_eq!(registry(&d).list()[0].id, id);
        registry(&d).remove(&id).unwrap();
        assert!(registry(&d).list().is_empty());
    }

    #[test]
    fn an_unacceptable_earlier_address_is_not_migrated() {
        let d = dirs();
        fs::create_dir_all(&d.config).unwrap();
        for text in ["", "nope", r#"{"server":"http://evil.example"}"#] {
            fs::write(d.config.join("config.json"), text).unwrap();
            assert!(registry(&d).list().is_empty(), "{text}");
        }
    }

    #[test]
    fn a_hand_damaged_file_keeps_what_still_makes_sense() {
        let d = dirs();
        fs::create_dir_all(&d.config).unwrap();
        let text = r#"{
          "workspaces": [
            {"id":"good","kind":"local","name":"Kept","preset":"tutorial","address":null,"lastOpened":3},
            {"id":"good","kind":"local","name":"Duplicate","preset":"blank","address":null,"lastOpened":null},
            {"id":"../../etc","kind":"local","name":"Escape","preset":"blank","address":null,"lastOpened":null},
            {"id":"BIG","kind":"local","name":"Upper","preset":"blank","address":null,"lastOpened":null},
            {"id":"nameless","kind":"local","name":"  ","preset":"blank","address":null,"lastOpened":null},
            {"id":"odd-preset","kind":"local","name":"Odd","preset":"chess","address":"https://x.example","lastOpened":-4},
            {"id":"bad-team","kind":"team","name":"Evil","preset":null,"address":"http://evil.example","lastOpened":null},
            {"id":"no-address","kind":"team","name":"None","preset":null,"address":null,"lastOpened":null},
            {"id":"team","kind":"team","name":"Team","preset":"blank","address":"https://qoop.example.org/","lastOpened":1},
            {"id":"strange","kind":"cloud","name":"Cloud"},
            42,
            "text"
          ],
          "openNext": "../../etc"
        }"#;
        fs::write(d.config.join("workspaces.json"), text).unwrap();
        let r = registry(&d);
        let list = r.list();
        let ids: Vec<_> = list.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["good", "team", "odd-preset"]);
        assert_eq!(list[0].name, "Kept");
        assert_eq!(list[1].address.as_deref(), Some("https://qoop.example.org"));
        assert_eq!(list[1].preset, None);
        assert_eq!(list[2].preset, None);
        assert_eq!(list[2].address, None);
        assert_eq!(list[2].last_opened, None);
        assert!(r.take_open_next().is_none());
    }

    #[test]
    fn a_file_that_is_not_json_is_kept_aside_and_started_over() {
        let d = dirs();
        fs::create_dir_all(&d.config).unwrap();
        for text in ["", "not json", "[1,2]", "{\"workspaces\": [", "null"] {
            fs::write(d.config.join("workspaces.json"), text).unwrap();
            let r = registry(&d);
            assert!(r.list().is_empty(), "{text:?}");
            r.create_local("blank", None).unwrap();
            assert_eq!(r.list().len(), 1, "{text:?}");
            assert_eq!(
                fs::read_to_string(d.config.join("workspaces.json.damaged")).unwrap(),
                text
            );
        }
        // Valid JSON without a list is an empty list, not damage.
        fs::write(d.config.join("workspaces.json"), "{}").unwrap();
        assert!(registry(&d).list().is_empty());
    }

    #[test]
    fn the_member_is_named_after_the_user() {
        assert_eq!(member_name_from(Some("egor")), "egor");
        assert_eq!(member_name_from(Some("  Ada Lovelace ")), "Ada Lovelace");
        assert_eq!(member_name_from(Some("")), "Me");
        assert_eq!(member_name_from(Some("a\nb")), "Me");
        assert_eq!(member_name_from(Some(&"x".repeat(101))), "Me");
        assert_eq!(member_name_from(None), "Me");
        assert!(!member_name().is_empty());
    }
}
