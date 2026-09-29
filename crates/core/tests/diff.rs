mod common;

use common::*;
use qoop_core::*;

#[test]
fn diff_of_equal_boards_is_empty() {
    let mut b = Board::new();
    b.apply(&card("A").1).unwrap();
    b.apply(&card("B").1).unwrap();
    assert!(diff_ops(&b, &b.clone()).is_empty());
}

#[test]
fn diff_orders_undelete_before_set_and_set_before_delete() {
    let (a, create_a) = card("A");
    let (b_id, create_b) = card("B");
    let mut from = Board::new();
    from.apply(&create_a).unwrap();
    from.apply(&create_b).unwrap();
    from.apply(&Op::Delete { entity: a }).unwrap();

    let mut to = from.clone();
    to.apply(&Op::Undelete { entity: a }).unwrap();
    to.apply(&set(a, "title", text("A2"))).unwrap();
    to.apply(&Op::Delete { entity: b_id }).unwrap();

    assert_eq!(
        diff_ops(&from, &to),
        vec![
            Op::Undelete { entity: a },
            set(a, "title", text("A2")),
            Op::Delete { entity: b_id },
        ]
    );
}

#[test]
fn diff_creates_cards_before_the_connections_that_need_them() {
    let (a, create_a) = card("A");
    let (b, create_b) = card("B");
    let (_, link) = connect(a, b);
    let mut to = Board::new();
    for op in [&create_a, &create_b, &link] {
        to.apply(op).unwrap();
    }

    let mut w = Board::new();
    for op in diff_ops(&Board::new(), &to) {
        assert!(w.apply(&op).is_ok(), "{op:?} rejected");
    }
    assert!(w.same_content(&to));
}

#[test]
fn diff_creates_then_deletes_a_tombstone_that_a_live_connection_points_at() {
    let (a, create_a) = card("A");
    let (b, create_b) = card("B");
    let (_, link) = connect(a, b);
    let mut to = Board::new();
    for op in [&create_a, &create_b, &link, &Op::Delete { entity: b }] {
        to.apply(op).unwrap();
    }
    let ops = diff_ops(&Board::new(), &to);
    assert_eq!(ops.last(), Some(&Op::Delete { entity: b }));
    let mut w = Board::new();
    for op in &ops {
        assert!(w.apply(op).is_ok(), "{op:?} rejected");
    }
    assert!(w.same_content(&to));
}

#[test]
fn scribble_produces_a_healthy_mix_of_ops() {
    // xorshift bytes: a fixed, well-mixed seed
    let mut x = 0x2545_f491_u32;
    let seed: Vec<u8> = (0..900)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            (x >> 8) as u8
        })
        .collect();
    let mut board = Board::new();
    let ops = scribble(&mut board, &seed);
    let count = |f: fn(&Op) -> bool| ops.iter().filter(|o| f(o)).count();
    let creates = |k: EntityKind| {
        ops.iter()
            .filter(|o| matches!(o, Op::Create { kind, .. } if *kind == k))
            .count()
    };
    let (cards, links) = (creates(EntityKind::Card), creates(EntityKind::Connection));
    let sets = count(|o| matches!(o, Op::Set { .. }));
    let deletes = count(|o| matches!(o, Op::Delete { .. }));
    let undeletes = count(|o| matches!(o, Op::Undelete { .. }));
    eprintln!("cards={cards} links={links} sets={sets} deletes={deletes} undeletes={undeletes}");
    assert!(cards > 5 && links > 5 && sets > 5 && deletes > 5 && undeletes > 5);
}

proptest::proptest! {
    #[test]
    fn applying_the_diff_reaches_the_target(
        a in proptest::collection::vec(proptest::num::u8::ANY, 0..90),
        b in proptest::collection::vec(proptest::num::u8::ANY, 0..90),
    ) {
        let mut from = Board::new();
        scribble(&mut from, &a);
        let mut to = from.clone();
        scribble(&mut to, &b);
        // forward: later state from earlier; backward: earlier state from later (this is Restore)
        for (x, y) in [(&from, &to), (&to, &from)] {
            let mut w = x.clone();
            for op in diff_ops(x, y) {
                proptest::prop_assert!(w.apply(&op).is_ok());
            }
            proptest::prop_assert!(w.same_content(y));
        }
    }
}
