mod common;
use common::*;
use infall_core::*;

fn at(branch: BranchId, seq: u64) -> Moment {
    Moment { branch, seq }
}

/// main: create A, create B (seq 2) | set A.title, delete B, create C (seq 5)
fn history() -> (Workspace, BranchId, MemberId, [EntityId; 3]) {
    let (mut ws, main) = Workspace::new();
    let me = MemberId::new();
    let (a, create_a) = card("A");
    let (b, create_b) = card("B");
    let (c, create_c) = card("C");
    for op in [
        create_a,
        create_b,
        set(a, "title", text("A2")),
        Op::Delete { entity: b },
        create_c,
    ] {
        ws.record(main, me, 1, op).unwrap();
    }
    (ws, main, me, [a, b, c])
}

#[test]
fn restore_brings_back_the_earlier_board_without_erasing_history() {
    let (mut ws, main, me, [_, _, c]) = history();
    let old_changes = ws.branch(main).unwrap().changes().to_vec();
    let head = ws.restore(main, 2, me, 9).unwrap();
    assert!(head.seq > 5);
    assert_eq!(head, ws.head(main).unwrap());
    assert!(
        ws.board_at(head)
            .unwrap()
            .same_content(&ws.board_at(at(main, 2)).unwrap())
    );
    let changes = ws.branch(main).unwrap().changes();
    assert_eq!(&changes[..5], &old_changes[..]);
    assert!(ws.board_at(head).unwrap().get(c).unwrap().deleted);
    let batch = match &changes[5].origin {
        Origin::Restore { batch, .. } => *batch,
        other => panic!("not a restore: {other:?}"),
    };
    for change in &changes[5..] {
        assert_eq!(change.origin, Origin::Restore { batch, to_seq: 2 });
    }
}

#[test]
fn a_restore_can_itself_be_undone() {
    let (mut ws, main, me, _) = history();
    let before = ws.head(main).unwrap().seq;
    assert_eq!(before, 5);
    ws.restore(main, 2, me, 9).unwrap();
    let head = ws.restore(main, before, me, 10).unwrap();
    assert!(
        ws.board_at(head)
            .unwrap()
            .same_content(&ws.board_at(at(main, 5)).unwrap())
    );
}

#[test]
fn restore_to_the_current_moment_records_nothing() {
    let (mut ws, main, me, _) = history();
    let snapshot = ws.clone();
    let head = ws.restore(main, 5, me, 9).unwrap();
    assert_eq!(head, at(main, 5));
    assert_eq!(ws, snapshot);
}

#[test]
fn restore_past_the_end_is_refused() {
    let (mut ws, main, me, _) = history();
    let snapshot = ws.clone();
    assert_eq!(
        ws.restore(main, 99, me, 9),
        Err(WsError::BadMoment(at(main, 99)))
    );
    assert_eq!(ws, snapshot);
}

#[test]
fn restore_on_a_fork_can_go_back_to_the_fork_moment() {
    let (mut ws, main, me, _) = history();
    let branch = ws.fork("side", at(main, 3), me, 5).unwrap();
    let fork_board = ws.board_at(at(main, 3)).unwrap();
    for i in 0..3 {
        ws.record(branch, me, 6, card(&format!("extra {i}")).1)
            .unwrap();
    }
    let head = ws.restore(branch, 0, me, 9).unwrap();
    assert!(head.seq > 3);
    assert!(ws.board_at(head).unwrap().same_content(&fork_board));
}

proptest::proptest! {
    #[test]
    fn restore_always_reaches_the_chosen_moment(
        seed in proptest::collection::vec(proptest::num::u8::ANY, 0..120),
        pick in 0usize..1000,
    ) {
        let (mut ws, main) = Workspace::new();
        let me = MemberId::new();
        let mut scratch = Board::new();
        for op in scribble(&mut scratch, &seed) {
            ws.record(main, me, 1, op).unwrap();
        }
        let len = ws.head(main).unwrap().seq as usize;
        let to = pick % (len + 1);
        let head = ws.restore(main, to as u64, me, 2).unwrap();
        proptest::prop_assert!(
            ws.board_at(head).unwrap().same_content(&ws.board_at(at(main, to as u64)).unwrap())
        );
    }
}
