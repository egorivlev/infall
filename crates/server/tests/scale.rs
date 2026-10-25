//! M15 — the Board at size (docs/specs/scale.md): a guard that fails when the server side
//! gets clearly slower. It generates a Workspace a tenth of the measured size and times what
//! the web UI asks of a Local Workspace on it, over a real socket.
//!
//! The limits are generous — several times what a debug build takes on the machine the
//! numbers were taken on — so that only a real regression (a replay of the whole history per
//! edit, a quadratic step) fails it, not a busy machine.

use std::time::Duration;

use qoop_server::scale::{Size, generate, measure};

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
        ("one edit", m.edit.ms, 1500.0),
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
}
