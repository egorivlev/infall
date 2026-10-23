//! The grouping rule of Activities, against the fixture shared with the web library.

use qoop_core::*;
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixture {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    gap_ms: i64,
    checkpoints: Vec<u64>,
    changes: Vec<Change>,
    expected: Vec<Activity>,
}

const FIXTURE: &str = include_str!("../../../docs/specs/branch-graph-activities.json");

#[test]
fn every_case_of_the_shared_fixture_groups_as_expected() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).unwrap();
    assert!(fixture.cases.len() >= 10);
    for case in &fixture.cases {
        let got = activities(&case.changes, &case.checkpoints, case.gap_ms);
        assert_eq!(got, case.expected, "{}", case.name);
    }
}

#[test]
fn the_fixture_s_changes_apply_in_order() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).unwrap();
    for case in &fixture.cases {
        let mut board = Board::new();
        for c in &case.changes {
            board.apply(&c.op).unwrap();
        }
    }
}

#[test]
fn activities_cover_the_log_in_order_whatever_the_input() {
    // A crude generator: authors, origins, times and Checkpoints from a little LCG.
    let mut x: u64 = 7;
    let mut next = move |m: u64| {
        x = x
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (x >> 33) % m
    };
    let people = [MemberId::new(), MemberId::new(), MemberId::new()];
    let batches = [BatchId::new(), BatchId::new()];
    let op = Op::Delete {
        entity: EntityId::new(),
    }; // never applied here
    for _ in 0..50 {
        let n = next(200) as usize;
        let mut at = 0i64;
        let changes: Vec<Change> = (0..n)
            .map(|_| {
                at += next(20 * 60_000) as i64 - 4 * 60_000;
                let origin = match next(6) {
                    0 => Origin::Restore {
                        batch: batches[next(2) as usize],
                        to_seq: 0,
                    },
                    1 => Origin::Merge {
                        batch: batches[next(2) as usize],
                        source: Moment {
                            branch: BranchId::new(),
                            seq: 1,
                        },
                    },
                    _ => Origin::Edit,
                };
                Change {
                    id: ChangeId::new(),
                    author: people[next(3) as usize],
                    at,
                    op: op.clone(),
                    origin,
                }
            })
            .collect();
        let cps: Vec<u64> = (0..next(8)).map(|_| next(n as u64 + 2)).collect();
        let got = activities(&changes, &cps, ACTIVITY_GAP_MS);
        let mut seq = 0;
        for a in &got {
            assert_eq!(a.from_seq, seq);
            assert!(a.to_seq > a.from_seq);
            // No Checkpoint strictly inside.
            assert!(!cps.iter().any(|&c| c > a.from_seq && c < a.to_seq));
            seq = a.to_seq;
        }
        assert_eq!(seq, n as u64);
    }
}

#[test]
fn ten_thousands_of_changes_group_quickly() {
    let me = MemberId::new();
    let id = EntityId::new();
    let changes: Vec<Change> = (0..100_000)
        .map(|i| Change {
            id: ChangeId::new(),
            author: me,
            at: i * 1000 + if i % 50 == 0 { 3_600_000 * i } else { 0 },
            op: Op::Delete { entity: id },
            origin: Origin::Edit,
        })
        .collect();
    let cps: Vec<u64> = (0..1000).map(|i| i * 97).collect();
    let start = std::time::Instant::now();
    let got = activities(&changes, &cps, ACTIVITY_GAP_MS);
    let took = start.elapsed();
    assert!(got.len() > 1000);
    assert!(took.as_millis() < 500, "{took:?}");
}
