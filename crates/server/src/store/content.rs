//! Research Content in tables (schema version 6; docs/specs/api.md §2).
//!
//! A Branch is one row of `branches`; its Changes are rows of `changes` in order (`seq` 1 is
//! its first Change), its Checkpoints rows of `checkpoints` and its sync points — what the
//! Merges between it and its parent left — rows of `sync_points`, both in the order they
//! were made (`ord`). Saving compares the Workspace with what is stored and writes only the
//! difference: Changes are only ever appended (docs/adr/0001), so an edit inserts its new
//! Changes and touches nothing else, whatever the length of the history.

use std::collections::{HashMap, HashSet};

use qoop_core::{
    BatchId, Branch, BranchId, BranchParts, Change, ChangeId, Checkpoint, MemberId, Moment, Op,
    Origin, SyncPoint, Workspace,
};
use rusqlite::{Connection, OptionalExtension, Row, params};
use uuid::Uuid;

use super::{StoreError, StoreResult};

/// M15 follow-up: Research Content in tables instead of one JSON row (`workspace`, which
/// the step to this version reads and drops).
pub(super) const SCHEMA_V6: &str = "
CREATE TABLE branches (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_branch TEXT,
    parent_seq INTEGER,
    created_by TEXT,
    created_at INTEGER
);
CREATE TABLE changes (
    branch TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    id TEXT NOT NULL,
    author TEXT NOT NULL,
    at INTEGER NOT NULL,
    op TEXT NOT NULL,
    origin TEXT NOT NULL,
    batch TEXT,
    to_seq INTEGER,
    source_branch TEXT,
    source_seq INTEGER,
    PRIMARY KEY (branch, seq)
);
CREATE TABLE checkpoints (
    branch TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    name TEXT NOT NULL,
    seq INTEGER NOT NULL,
    author TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (branch, ord)
);
CREATE TABLE sync_points (
    branch TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    base_branch TEXT NOT NULL,
    base_seq INTEGER NOT NULL,
    landed_branch TEXT,
    landed_seq INTEGER,
    PRIMARY KEY (branch, ord)
);
";

/// The migration step to version 6: the tables, filled from the old `workspace` row, read
/// back and compared with it before the row is dropped. Runs inside the migration's
/// transaction, so a Workspace that does not come back exactly leaves the file as it was.
pub(super) fn from_json_row(conn: &Connection) -> StoreResult<()> {
    conn.execute_batch(SCHEMA_V6)?;
    let json: Option<String> = conn
        .query_row("SELECT json FROM workspace WHERE id = 1", [], |r| r.get(0))
        .optional()?;
    if let Some(json) = json {
        let ws: Workspace = serde_json::from_str(&json)?;
        save(conn, &ws)?;
        if load(conn)?.as_ref() != Some(&ws) {
            return Err(StoreError::Backend(
                "the Workspace read back from its new tables is not the one in the old file"
                    .to_string(),
            ));
        }
    }
    conn.execute_batch("DROP TABLE workspace")?;
    Ok(())
}

// ---------------------------------------------------------------- reading

fn bad(what: impl Into<String>) -> StoreError {
    StoreError::Backend(format!("stored Workspace: {}", what.into()))
}

fn uuid(s: &str) -> StoreResult<Uuid> {
    Uuid::parse_str(s).map_err(|e| bad(format!("id {s:?}: {e}")))
}

fn seq(n: i64) -> StoreResult<u64> {
    u64::try_from(n).map_err(|_| bad(format!("position {n}")))
}

fn moment(branch: &str, n: i64) -> StoreResult<Moment> {
    Ok(Moment {
        branch: BranchId(uuid(branch)?),
        seq: seq(n)?,
    })
}

/// The Workspace held in the tables; `None` if they hold no Branch (a new database).
pub(super) fn load(conn: &Connection) -> StoreResult<Option<Workspace>> {
    let mut parts: Vec<BranchParts> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, name, parent_branch, parent_seq, created_by, created_at
             FROM branches ORDER BY id",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(r) = rows.next()? {
            let id: String = r.get(0)?;
            let parent = match (r.get::<_, Option<String>>(2)?, r.get::<_, Option<i64>>(3)?) {
                (Some(b), Some(n)) => Some(moment(&b, n)?),
                (None, None) => None,
                _ => return Err(bad(format!("Branch {id} has half a parent"))),
            };
            index.insert(id.clone(), parts.len());
            parts.push(BranchParts {
                id: BranchId(uuid(&id)?),
                name: r.get(1)?,
                parent,
                created_by: r
                    .get::<_, Option<String>>(4)?
                    .map(|m| uuid(&m).map(MemberId))
                    .transpose()?,
                created_at: r.get(5)?,
                changes: Vec::new(),
                sync_points: Vec::new(),
                checkpoints: Vec::new(),
            });
        }
    }
    if parts.is_empty() {
        return Ok(None);
    }
    let owner = |branch: &str| -> StoreResult<usize> {
        index
            .get(branch)
            .copied()
            .ok_or_else(|| bad(format!("a row of the unknown Branch {branch}")))
    };

    {
        let mut stmt = conn.prepare(
            "SELECT branch, seq, id, author, at, op, origin, batch, to_seq, source_branch,
                    source_seq
             FROM changes ORDER BY branch, seq",
        )?;
        let mut rows = stmt.query([])?;
        let mut last: Option<(String, usize)> = None;
        while let Some(r) = rows.next()? {
            let branch = r.get_ref(0)?.as_str().map_err(rusqlite::Error::from)?;
            let i = match &last {
                Some((b, i)) if b == branch => *i,
                _ => {
                    let i = owner(branch)?;
                    last = Some((branch.to_string(), i));
                    i
                }
            };
            let changes = &mut parts[i].changes;
            let n: i64 = r.get(1)?;
            if seq(n)? != changes.len() as u64 + 1 {
                return Err(bad(format!(
                    "Branch {branch} has no Change {}",
                    changes.len() + 1
                )));
            }
            changes.push(change_row(r)?);
        }
    }
    {
        let mut stmt = conn.prepare(
            "SELECT branch, name, seq, author, at FROM checkpoints ORDER BY branch, ord",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(r) = rows.next()? {
            let branch: String = r.get(0)?;
            let i = owner(&branch)?;
            parts[i].checkpoints.push(Checkpoint {
                name: r.get(1)?,
                moment: moment(&branch, r.get(2)?)?,
                author: MemberId(uuid(&r.get::<_, String>(3)?)?),
                at: r.get(4)?,
            });
        }
    }
    {
        let mut stmt = conn.prepare(
            "SELECT branch, base_branch, base_seq, landed_branch, landed_seq
             FROM sync_points ORDER BY branch, ord",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(r) = rows.next()? {
            let branch: String = r.get(0)?;
            let i = owner(&branch)?;
            parts[i].sync_points.push(sync_point_row(r, 1)?);
        }
    }
    Ok(Some(Workspace::from_parts(parts)))
}

/// A `changes` row from its third column on (`id`, …).
fn change_row(r: &Row<'_>) -> StoreResult<Change> {
    let op: String = r.get(5)?;
    let op: Op = serde_json::from_str(&op)?;
    let kind: String = r.get(6)?;
    let batch = || -> StoreResult<BatchId> {
        let b: Option<String> = r.get(7)?;
        Ok(BatchId(uuid(
            b.as_deref().ok_or_else(|| bad("a batch without its id"))?,
        )?))
    };
    let origin = match kind.as_str() {
        "edit" => Origin::Edit,
        "restore" => Origin::Restore {
            batch: batch()?,
            to_seq: seq(r
                .get::<_, Option<i64>>(8)?
                .ok_or_else(|| bad("a Restore without its moment"))?)?,
        },
        "merge" => {
            let source: (Option<String>, Option<i64>) = (r.get(9)?, r.get(10)?);
            let (Some(b), Some(n)) = source else {
                return Err(bad("a Merge without its source"));
            };
            Origin::Merge {
                batch: batch()?,
                source: moment(&b, n)?,
            }
        }
        other => return Err(bad(format!("origin {other:?}"))),
    };
    Ok(Change {
        id: ChangeId(uuid(&r.get::<_, String>(2)?)?),
        author: MemberId(uuid(&r.get::<_, String>(3)?)?),
        at: r.get(4)?,
        op,
        origin,
    })
}

/// A sync point from the four columns starting at `from`.
fn sync_point_row(r: &Row<'_>, from: usize) -> StoreResult<SyncPoint> {
    let base_branch: String = r.get(from)?;
    let landed = match (
        r.get::<_, Option<String>>(from + 2)?,
        r.get::<_, Option<i64>>(from + 3)?,
    ) {
        (Some(b), Some(n)) => Some(moment(&b, n)?),
        (None, None) => None,
        _ => return Err(bad("a sync point with half a landing")),
    };
    Ok(SyncPoint {
        base: moment(&base_branch, r.get(from + 1)?)?,
        landed,
    })
}

// ---------------------------------------------------------------- writing

/// The `branches` row of a Branch.
#[derive(PartialEq)]
struct BranchRow {
    name: String,
    parent_branch: Option<String>,
    parent_seq: Option<i64>,
    created_by: Option<String>,
    created_at: Option<i64>,
}

impl BranchRow {
    fn of(b: &Branch) -> BranchRow {
        BranchRow {
            name: b.name().to_string(),
            parent_branch: b.parent().map(|m| m.branch.0.to_string()),
            parent_seq: b.parent().map(|m| m.seq as i64),
            created_by: b.created_by().map(|m| m.0.to_string()),
            created_at: b.created_at(),
        }
    }
}

/// Brings the tables to `ws`, writing only what differs. Call inside a transaction.
///
/// For each Branch the stored rows are a prefix of its Changes, Checkpoints and sync points
/// (checked by the last of each, whose id or content must match), and only the rest is
/// inserted. Anything else — a sync point forgotten by a Restore, or a Workspace that is not
/// a continuation of the stored one — rewrites that list of that Branch whole.
pub(super) fn save(conn: &Connection, ws: &Workspace) -> StoreResult<()> {
    let mut stored: HashMap<String, BranchRow> = HashMap::new();
    {
        let mut stmt = conn.prepare_cached(
            "SELECT id, name, parent_branch, parent_seq, created_by, created_at FROM branches",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(r) = rows.next()? {
            stored.insert(
                r.get(0)?,
                BranchRow {
                    name: r.get(1)?,
                    parent_branch: r.get(2)?,
                    parent_seq: r.get(3)?,
                    created_by: r.get(4)?,
                    created_at: r.get(5)?,
                },
            );
        }
    }
    let mut kept: HashSet<String> = HashSet::new();
    for b in ws.branches() {
        let id = b.id().0.to_string();
        let row = BranchRow::of(b);
        match stored.get(&id) {
            Some(was) if *was == row => {}
            Some(_) => {
                conn.prepare_cached(
                    "UPDATE branches SET name = ?2, parent_branch = ?3, parent_seq = ?4,
                         created_by = ?5, created_at = ?6
                     WHERE id = ?1",
                )?
                .execute(params![
                    id,
                    row.name,
                    row.parent_branch,
                    row.parent_seq,
                    row.created_by,
                    row.created_at
                ])?;
            }
            None => {
                conn.prepare_cached(
                    "INSERT INTO branches
                         (id, name, parent_branch, parent_seq, created_by, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                )?
                .execute(params![
                    id,
                    row.name,
                    row.parent_branch,
                    row.parent_seq,
                    row.created_by,
                    row.created_at
                ])?;
            }
        }
        save_changes(conn, &id, b.changes())?;
        save_checkpoints(conn, &id, b.recorded_checkpoints())?;
        save_sync_points(conn, &id, b.sync_points())?;
        kept.insert(id);
    }
    for id in stored.keys().filter(|id| !kept.contains(*id)) {
        for table in ["changes", "checkpoints", "sync_points"] {
            conn.execute(
                &format!("DELETE FROM {table} WHERE branch = ?1"),
                params![id],
            )?;
        }
        conn.execute("DELETE FROM branches WHERE id = ?1", params![id])?;
    }
    Ok(())
}

/// How many of `wanted` are stored already, given the stored count and whether the stored
/// last one is `wanted[count - 1]`; `None` when the stored rows must be replaced.
fn kept_prefix(
    count: usize,
    len: usize,
    last_matches: impl FnOnce(usize) -> bool,
) -> Option<usize> {
    if count == 0 {
        Some(0)
    } else if count <= len && last_matches(count - 1) {
        Some(count)
    } else {
        None
    }
}

fn save_changes(conn: &Connection, branch: &str, changes: &[Change]) -> StoreResult<()> {
    let last: Option<(i64, String)> = conn
        .prepare_cached("SELECT seq, id FROM changes WHERE branch = ?1 ORDER BY seq DESC LIMIT 1")?
        .query_row(params![branch], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    let (count, last_id) = match last {
        Some((n, id)) => (usize::try_from(n).unwrap_or(usize::MAX), id),
        None => (0, String::new()),
    };
    let keep = kept_prefix(count, changes.len(), |i| {
        changes[i].id.0.to_string() == last_id
    });
    let keep = match keep {
        Some(n) => n,
        None => {
            conn.prepare_cached("DELETE FROM changes WHERE branch = ?1")?
                .execute(params![branch])?;
            0
        }
    };
    let mut insert = conn.prepare_cached(
        "INSERT INTO changes (branch, seq, id, author, at, op, origin, batch, to_seq,
             source_branch, source_seq)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
    )?;
    for (i, c) in changes.iter().enumerate().skip(keep) {
        let (origin, batch, to_seq, source) = match &c.origin {
            Origin::Edit => ("edit", None, None, None),
            Origin::Restore { batch, to_seq } => ("restore", Some(*batch), Some(*to_seq), None),
            Origin::Merge { batch, source } => ("merge", Some(*batch), None, Some(*source)),
        };
        insert.execute(params![
            branch,
            i as i64 + 1,
            c.id.0.to_string(),
            c.author.0.to_string(),
            c.at,
            serde_json::to_string(&c.op)?,
            origin,
            batch.map(|b| b.0.to_string()),
            to_seq.map(|n| n as i64),
            source.map(|m| m.branch.0.to_string()),
            source.map(|m| m.seq as i64),
        ])?;
    }
    Ok(())
}

fn save_checkpoints(conn: &Connection, branch: &str, list: &[Checkpoint]) -> StoreResult<()> {
    type Last = (i64, String, i64, String, i64);
    let last: Option<Last> = conn
        .prepare_cached(
            "SELECT ord, name, seq, author, at FROM checkpoints WHERE branch = ?1
             ORDER BY ord DESC LIMIT 1",
        )?
        .query_row(params![branch], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .optional()?;
    let keep = match &last {
        None => Some(0),
        Some((ord, name, seq, author, at)) => {
            let count = usize::try_from(*ord).map_or(usize::MAX, |n| n + 1);
            kept_prefix(count, list.len(), |i| {
                let c = &list[i];
                c.name == *name
                    && c.moment.seq as i64 == *seq
                    && c.moment.branch.0.to_string() == branch
                    && c.author.0.to_string() == *author
                    && c.at == *at
            })
        }
    };
    let keep = match keep {
        Some(n) => n,
        None => {
            conn.prepare_cached("DELETE FROM checkpoints WHERE branch = ?1")?
                .execute(params![branch])?;
            0
        }
    };
    let mut insert = conn.prepare_cached(
        "INSERT INTO checkpoints (branch, ord, name, seq, author, at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    for (i, c) in list.iter().enumerate().skip(keep) {
        if c.moment.branch.0.to_string() != branch {
            return Err(bad(format!(
                "Checkpoint {:?} on Branch {branch} names a moment of another Branch",
                c.name
            )));
        }
        insert.execute(params![
            branch,
            i as i64,
            c.name,
            c.moment.seq as i64,
            c.author.0.to_string(),
            c.at
        ])?;
    }
    Ok(())
}

fn save_sync_points(conn: &Connection, branch: &str, list: &[SyncPoint]) -> StoreResult<()> {
    let stored: Vec<SyncPoint> = {
        let mut stmt = conn.prepare_cached(
            "SELECT base_branch, base_seq, landed_branch, landed_seq FROM sync_points
             WHERE branch = ?1 ORDER BY ord",
        )?;
        let mut rows = stmt.query(params![branch])?;
        let mut out = Vec::new();
        while let Some(r) = rows.next()? {
            out.push(sync_point_row(r, 0)?);
        }
        out
    };
    let keep = if list.starts_with(&stored) {
        stored.len()
    } else {
        conn.prepare_cached("DELETE FROM sync_points WHERE branch = ?1")?
            .execute(params![branch])?;
        0
    };
    let mut insert = conn.prepare_cached(
        "INSERT INTO sync_points (branch, ord, base_branch, base_seq, landed_branch, landed_seq)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    for (i, p) in list.iter().enumerate().skip(keep) {
        insert.execute(params![
            branch,
            i as i64,
            p.base.branch.0.to_string(),
            p.base.seq as i64,
            p.landed.map(|m| m.branch.0.to_string()),
            p.landed.map(|m| m.seq as i64),
        ])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use qoop_core::{Decision, Decisions, EntityId, EntityKind, Fields, Value};

    fn tables() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute_batch(SCHEMA_V6).unwrap();
        conn
    }

    fn card(id: EntityId, title: &str) -> Op {
        let mut fields = Fields::new();
        fields.insert("title".to_string(), Value::Text(title.to_string()));
        Op::Create {
            entity: id,
            kind: EntityKind::Card,
            fields,
        }
    }

    fn set(id: EntityId, title: &str) -> Op {
        Op::Set {
            entity: id,
            field: "title".to_string(),
            value: Value::Text(title.to_string()),
        }
    }

    /// Saves `ws` and returns how many rows that wrote; the tables then read back as `ws`.
    fn saved(conn: &Connection, ws: &Workspace) -> u64 {
        let before = conn.total_changes();
        save(conn, ws).unwrap();
        let written = conn.total_changes() - before;
        assert_eq!(load(conn).unwrap().as_ref(), Some(ws));
        written
    }

    #[test]
    fn each_save_writes_only_what_was_added_and_reads_back_the_same() {
        let conn = tables();
        assert_eq!(load(&conn).unwrap(), None);
        let (mut ws, main) = Workspace::new();
        let me = MemberId::new();
        // A new Branch row, nothing else.
        assert_eq!(saved(&conn, &ws), 1);

        let a = EntityId::new();
        ws.record_all(main, me, 1, vec![card(a, "a"), set(a, "b")])
            .unwrap();
        assert_eq!(saved(&conn, &ws), 2);
        for i in 0..50 {
            ws.record(main, me, 2 + i, set(a, &format!("t{i}")))
                .unwrap();
        }
        assert_eq!(saved(&conn, &ws), 50);
        // One edit is one row, however long the history.
        ws.record(main, me, 60, set(a, "one more")).unwrap();
        assert_eq!(saved(&conn, &ws), 1);
        // Nothing new, nothing written.
        assert_eq!(saved(&conn, &ws), 0);

        ws.checkpoint("first", ws.head(main).unwrap(), me, 61)
            .unwrap();
        assert_eq!(saved(&conn, &ws), 1);
        let side = ws.fork("side", ws.head(main).unwrap(), me, 62).unwrap();
        // The Branch and its fork point.
        assert_eq!(saved(&conn, &ws), 2);
        ws.record(side, me, 63, set(a, "on the side")).unwrap();
        ws.record(main, me, 64, set(a, "on main")).unwrap();
        assert_eq!(saved(&conn, &ws), 2);

        // A Merge with a Conflict decided for the source, and a Checkpoint before it.
        let plan = ws.plan_merge(side, main).unwrap();
        let mut decisions = Decisions::new();
        for c in &plan.conflicts {
            decisions.insert(c.key(), Decision::TakeSource);
        }
        assert!(!decisions.is_empty());
        let before_merge = ws.head(main).unwrap();
        ws.apply_merge(&plan, &decisions, me, 65, Some("before the merge"))
            .unwrap();
        let landed = ws.branch(side).unwrap().sync_points().len();
        assert_eq!(landed, 2);
        saved(&conn, &ws);

        // A Restore to before the Merge forgets it: the side's sync points get shorter,
        // and are written again.
        ws.restore(main, before_merge.seq, me, 66).unwrap();
        assert_eq!(ws.branch(side).unwrap().sync_points().len(), 1);
        saved(&conn, &ws);
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_points", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);

        // Every Change is there once, in order.
        let total: usize = ws.branches().map(|b| b.changes().len()).sum();
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM changes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows as usize, total);
    }

    #[test]
    fn a_workspace_that_does_not_continue_the_stored_one_replaces_it() {
        let conn = tables();
        let me = MemberId::new();
        let (mut first, main) = Workspace::new();
        let a = EntityId::new();
        first.record(main, me, 1, card(a, "a")).unwrap();
        first.record(main, me, 2, set(a, "b")).unwrap();
        let side = first
            .fork("side", first.head(main).unwrap(), me, 3)
            .unwrap();
        first.record(side, me, 4, set(a, "c")).unwrap();
        first
            .checkpoint("x", first.head(main).unwrap(), me, 5)
            .unwrap();
        saved(&conn, &first);

        // Another Workspace altogether (as when a file is imported over it): other ids.
        let (mut other, other_main) = Workspace::new();
        let b = EntityId::new();
        for i in 0..3 {
            other
                .record(other_main, me, 10 + i, card(EntityId::new(), "n"))
                .unwrap();
        }
        other.record(other_main, me, 20, card(b, "b")).unwrap();
        saved(&conn, &other);
        let branches: i64 = conn
            .query_row("SELECT COUNT(*) FROM branches", [], |r| r.get(0))
            .unwrap();
        assert_eq!(branches, 1);

        // The same Branch with a history of the same length but other Changes, and fewer
        // Checkpoints than stored: each list is written again.
        let mut again = first.clone();
        saved(&conn, &again);
        let b = first.branch(main).unwrap();
        let rewritten = Workspace::from_parts([BranchParts {
            id: b.id(),
            name: b.name().to_string(),
            parent: None,
            created_by: None,
            created_at: None,
            changes: b
                .changes()
                .iter()
                .map(|c| Change {
                    id: ChangeId::new(),
                    ..c.clone()
                })
                .collect(),
            sync_points: Vec::new(),
            checkpoints: Vec::new(),
        }]);
        saved(&conn, &rewritten);
        again.record(main, me, 30, set(a, "d")).unwrap();
        saved(&conn, &again);
    }
}
