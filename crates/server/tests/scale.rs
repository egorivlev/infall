//! M15 — the Board at size (docs/specs/scale.md): a guard that fails when the server side
//! gets clearly slower. It generates a Workspace a tenth of the measured size and times what
//! the web UI asks of a Local Workspace on it, over a real socket.
//!
//! The limits are generous — several times what a debug build takes on the machine the
//! numbers were taken on — so that only a real regression (a replay of the whole history per
//! edit, a quadratic step) fails it, not a busy machine.
//!
//! What one edit writes to the database is not timed but counted, so that it cannot grow
//! with the history again unnoticed: the bytes it adds to the write-ahead log, at two
//! lengths of history.

use std::time::Duration;

use infall_core::{EntityKind, Op, Value, Workspace};
use infall_server::scale::{Size, generate, measure};
use infall_server::store::{SqliteStore, Store};

#[tokio::test(flavor = "multi_thread")]
async fn a_large_workspace_opens_edits_and_travels_quickly() {
    let dir = tempfile::tempdir().unwrap();
    let web = tempfile::tempdir().unwrap();
    std::fs::write(
        web.path().join("index.html"),
        "<!doctype html><title>t</title>",
    )
    .unwrap();
    let db = dir.path().join("small.db");

    let size = Size::small();
    let g = generate(&size, &db).unwrap();
    assert!(g.changes >= size.changes, "{g:?}");
    assert_eq!(g.branches, size.branches);
    assert!(g.merged >= 1 && g.checkpoints >= 1, "{g:?}");
    assert!(
        g.cards >= size.cards && g.connections >= size.connections / 2,
        "{g:?}"
    );
    assert!(g.open_branch.is_some() && g.long_page.is_some());
    // Recording replays nothing once the head Board is known: 0.2 s in a debug build
    // here. Replaying the history for every edit made it tens of seconds.
    assert!(
        g.took < Duration::from_secs(8),
        "generating took {:?}",
        g.took
    );

    let m = measure(&db, web.path(), dir.path(), g.open_branch, 5)
        .await
        .unwrap();
    eprintln!("{g:#?}\n{m:#?}");
    let limits = [
        ("start", m.start.ms, 3000.0),
        ("first Board", m.board.ms, 2000.0),
        ("History", m.history.ms, 4000.0),
        ("Merge preview", m.merge_plan.map_or(0.0, |t| t.ms), 2000.0),
        // About 3 ms in a debug build here, since the store appends the new Changes
        // instead of writing the whole Workspace.
        ("one edit", m.edit.ms, 250.0),
        ("export", m.export.ms, 5000.0),
        ("import", m.import.ms, 5000.0),
    ];
    for (what, ms, limit) in limits {
        assert!(
            ms < limit,
            "{what} took {ms:.0} ms (limit {limit} ms): {m:?}"
        );
    }
    assert!(m.board.bytes > 100_000 && m.export.bytes > 0, "{m:?}");

    let (first, later) = bytes_one_edit_writes(&db);
    eprintln!("one edit wrote {first} bytes, and {later} after 3 000 more Changes");
    // A few pages (the new rows and the index entries pointing at them), the same at any
    // length of history. Rewriting the Workspace, as the store did up to M15, is about 600
    // pages (2.4 MB) at this size and grows with every Change.
    for written in [first, later] {
        assert!(
            written <= 64 * 1024,
            "one edit wrote {written} bytes to the database"
        );
    }
}

/// What the store writes for one edit — a Card moved, two Sets — on the generated
/// Workspace and again after 3 000 more Changes: the bytes added to the write-ahead log,
/// emptied before each.
fn bytes_one_edit_writes(db: &std::path::Path) -> (u64, u64) {
    let store = SqliteStore::open(db).unwrap();
    let mut ws: Workspace = store.load_workspace().unwrap().unwrap();
    let main = ws.branch_by_name("main").unwrap().id();
    let card = ws
        .head_board(main)
        .unwrap()
        .entities()
        .find(|(_, e)| e.kind == EntityKind::Card && !e.deleted)
        .map(|(id, _)| id)
        .unwrap();
    let mut wal = db.as_os_str().to_os_string();
    wal.push("-wal");
    let wal = std::path::PathBuf::from(wal);
    let checkpoint = rusqlite::Connection::open(db).unwrap();
    let me = ws.branch(main).unwrap().changes()[0].author;
    let mut at = 1_900_000_000_000;
    let mut move_card = |ws: &mut Workspace, x: f64| {
        at += 1;
        let set = |field: &str, v: f64| Op::Set {
            entity: card,
            field: field.to_string(),
            value: Value::Float(v),
        };
        ws.record_all(main, me, at, vec![set("x", x), set("y", 50.0)])
            .unwrap();
    };
    let one_edit = |ws: &mut Workspace, move_card: &mut dyn FnMut(&mut Workspace, f64)| {
        let _: (i64, i64, i64) = checkpoint
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!(std::fs::metadata(&wal).map_or(0, |m| m.len()), 0);
        move_card(ws, 1.0);
        store.save_workspace(ws).unwrap();
        std::fs::metadata(&wal).unwrap().len()
    };
    let first = one_edit(&mut ws, &mut move_card);
    for i in 0..1500 {
        move_card(&mut ws, f64::from(i));
    }
    store.save_workspace(&ws).unwrap();
    let later = one_edit(&mut ws, &mut move_card);
    (first, later)
}
