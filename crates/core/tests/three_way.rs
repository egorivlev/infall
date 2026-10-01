mod common;

use common::*;
use qoop_core::*;

fn delete(entity: EntityId) -> Op {
    Op::Delete { entity }
}

fn undelete(entity: EntityId) -> Op {
    Op::Undelete { entity }
}

fn apply_all(board: &mut Board, ops: &[Op]) {
    for op in ops {
        board.apply(op).unwrap();
    }
}

/// A base Board holding one Card titled `title`, plus clones for source and target.
fn one_card(title: &str) -> (EntityId, Board, Board, Board) {
    let (id, create) = card(title);
    let mut base = Board::new();
    base.apply(&create).unwrap();
    (id, base.clone(), base.clone(), base)
}

#[test]
fn same_title_changed_both_ways_is_a_field_conflict() {
    let (id, base, mut source, mut target) = one_card("Surface codes");
    source
        .apply(&set(id, "title", text("Surface & toric codes")))
        .unwrap();
    target
        .apply(&set(id, "title", text("Surface codes (review)")))
        .unwrap();

    let (auto, conflicts) = three_way(&base, &source, &target);
    assert!(auto.is_empty());
    assert_eq!(
        conflicts,
        vec![Conflict::Field {
            entity: id,
            field: "title".to_string(),
            base: text("Surface codes"),
            source: text("Surface & toric codes"),
            target: text("Surface codes (review)"),
        }]
    );
    assert_eq!(
        conflicts[0].key(),
        ConflictKey {
            entity: id,
            field: Some("title".to_string())
        }
    );
}

#[test]
fn different_fields_of_one_card_both_survive() {
    let (id, base, mut source, mut target) = one_card("A");
    source.apply(&set(id, "summary", text("s"))).unwrap();
    target.apply(&set(id, "title", text("T"))).unwrap();

    let (auto, conflicts) = three_way(&base, &source, &target);
    assert_eq!(auto, vec![set(id, "summary", text("s"))]);
    assert!(conflicts.is_empty());
}

#[test]
fn both_sides_made_the_same_edit_is_nothing() {
    let (id, base, mut source, mut target) = one_card("A");
    source.apply(&set(id, "title", text("X"))).unwrap();
    target.apply(&set(id, "title", text("X"))).unwrap();

    assert_eq!(three_way(&base, &source, &target), (vec![], vec![]));
}

#[test]
fn layout_disagreement_follows_the_target() {
    let (id, base, mut source, mut target) = one_card("A");
    source.apply(&set(id, "x", Value::Float(10.0))).unwrap();
    target.apply(&set(id, "x", Value::Float(99.0))).unwrap();

    assert_eq!(three_way(&base, &source, &target), (vec![], vec![]));
}

#[test]
fn layout_moved_only_on_source_comes_across() {
    let (id, base, mut source, target) = one_card("A");
    source.apply(&set(id, "x", Value::Float(10.0))).unwrap();

    assert_eq!(
        three_way(&base, &source, &target),
        (vec![set(id, "x", Value::Float(10.0))], vec![])
    );
}

#[test]
fn a_card_new_on_source_is_created_with_its_fields() {
    let base = Board::new();
    let target = base.clone();

    let mut source = base.clone();
    let (_, create) = card("QEC thresholds");
    source.apply(&create).unwrap();
    assert_eq!(three_way(&base, &source, &target), (vec![create], vec![]));

    let mut source = base.clone();
    let (gone, create_gone) = card("QEC thresholds");
    source.apply(&create_gone).unwrap();
    source.apply(&delete(gone)).unwrap();
    assert_eq!(
        three_way(&base, &source, &target),
        (vec![create_gone, delete(gone)], vec![])
    );
}

#[test]
fn a_connection_to_a_card_created_and_deleted_on_source_still_merges() {
    let (a, base, mut source, mut target) = one_card("A");
    let (q, create_q) = card("Q");
    let (link, create_link) = connect(a, q);
    apply_all(
        &mut source,
        &[create_q.clone(), create_link.clone(), delete(q)],
    );

    let (auto, conflicts) = three_way(&base, &source, &target);
    assert_eq!(auto, vec![create_q, create_link, delete(q)]);
    assert!(conflicts.is_empty());
    for op in &auto {
        assert!(target.apply(op).is_ok(), "{op:?} rejected");
    }
    assert!(target.get(q).is_some_and(|e| e.deleted));
    assert!(!target.is_visible(link));
}

#[test]
fn a_card_absent_from_base_but_deleted_on_target_comes_back_from_source() {
    let base = Board::new();
    let (q, create_old) = card("old");
    let create_new = Op::Create {
        entity: q,
        kind: EntityKind::Card,
        fields: [("title".to_string(), text("new"))].into(),
    };
    let mut source = Board::new();
    source.apply(&create_new).unwrap();
    let mut target = Board::new();
    apply_all(&mut target, &[create_old, delete(q)]);

    assert_eq!(
        three_way(&base, &source, &target),
        (vec![undelete(q), set(q, "title", text("new"))], vec![])
    );
}

#[test]
fn a_card_absent_from_base_and_live_on_both_compares_against_no_fields() {
    let base = Board::new();
    let (q, create_old) = card("old");
    let create_new = Op::Create {
        entity: q,
        kind: EntityKind::Card,
        fields: [
            ("title".to_string(), text("new")),
            ("x".to_string(), Value::Float(3.0)),
        ]
        .into(),
    };
    let mut source = Board::new();
    source.apply(&create_new).unwrap();
    let mut target = Board::new();
    target.apply(&create_old).unwrap();

    // title: changed on both to different values (content) -> Conflict against a Null base;
    // x: changed only on source -> Set.
    assert_eq!(
        three_way(&base, &source, &target),
        (
            vec![set(q, "x", Value::Float(3.0))],
            vec![Conflict::Field {
                entity: q,
                field: "title".to_string(),
                base: Value::Null,
                source: text("new"),
                target: text("old"),
            }]
        )
    );
}

#[test]
fn a_card_absent_from_base_and_deleted_on_source_but_live_on_target_is_nothing() {
    let base = Board::new();
    let (q, create) = card("Q");
    let mut source = Board::new();
    apply_all(&mut source, &[create.clone(), delete(q)]);
    let mut target = Board::new();
    apply_all(&mut target, &[create, set(q, "title", text("edited"))]);

    assert_eq!(three_way(&base, &source, &target), (vec![], vec![]));
}

#[test]
fn a_card_new_on_target_is_left_alone() {
    let (_, base, source, mut target) = one_card("A");
    target.apply(&card("Only on target").1).unwrap();

    assert_eq!(three_way(&base, &source, &target), (vec![], vec![]));
}

#[test]
fn deleted_on_both_sides_is_nothing() {
    let (id, base, mut source, mut target) = one_card("A");
    apply_all(&mut source, &[set(id, "title", text("S")), delete(id)]);
    apply_all(&mut target, &[set(id, "title", text("T")), delete(id)]);

    assert_eq!(three_way(&base, &source, &target), (vec![], vec![]));
}

#[test]
fn source_deleted_and_target_only_moved_it_is_deleted() {
    let (id, base, mut source, mut target) = one_card("Grover search");
    source.apply(&delete(id)).unwrap();
    target.apply(&set(id, "x", Value::Float(42.0))).unwrap();

    assert_eq!(
        three_way(&base, &source, &target),
        (vec![delete(id)], vec![])
    );
}

#[test]
fn source_deleted_but_target_edited_content_is_a_conflict() {
    let (id, base, mut source, mut target) = one_card("Grover search");
    source.apply(&delete(id)).unwrap();
    target
        .apply(&set(id, "title", text("Grover search, revisited")))
        .unwrap();

    let (auto, conflicts) = three_way(&base, &source, &target);
    assert!(!auto.contains(&delete(id)));
    assert_eq!(
        conflicts,
        vec![Conflict::EditVsDelete {
            entity: id,
            deleted_on: Side::Source,
        }]
    );
    assert_eq!(
        conflicts[0].key(),
        ConflictKey {
            entity: id,
            field: None
        }
    );
}

#[test]
fn target_deleted_but_source_edited_content_is_a_conflict() {
    let (id, base, mut source, mut target) = one_card("A");
    source
        .apply(&set(id, "summary", text("new notes")))
        .unwrap();
    target.apply(&delete(id)).unwrap();

    assert_eq!(
        three_way(&base, &source, &target),
        (
            vec![],
            vec![Conflict::EditVsDelete {
                entity: id,
                deleted_on: Side::Target,
            }]
        )
    );
}

#[test]
fn target_deleted_and_source_untouched_stays_deleted() {
    let (id, base, source, mut target) = one_card("A");
    target.apply(&delete(id)).unwrap();

    assert_eq!(three_way(&base, &source, &target), (vec![], vec![]));
}

#[test]
fn target_deleted_and_source_only_moved_it_stays_deleted() {
    let (id, base, mut source, mut target) = one_card("A");
    source.apply(&set(id, "x", Value::Float(7.0))).unwrap();
    target.apply(&delete(id)).unwrap();

    assert_eq!(three_way(&base, &source, &target), (vec![], vec![]));
}

#[test]
fn undeleted_on_source_comes_back_on_target() {
    let (id, mut base, _, _) = one_card("A");
    base.apply(&delete(id)).unwrap();
    let target = base.clone();
    let mut source = base.clone();
    apply_all(
        &mut source,
        &[
            undelete(id),
            set(id, "title", text("X")),
            set(id, "x", Value::Float(5.0)),
        ],
    );

    assert_eq!(
        three_way(&base, &source, &target),
        (
            vec![
                undelete(id),
                set(id, "title", text("X")),
                set(id, "x", Value::Float(5.0)),
            ],
            vec![]
        )
    );
}

#[test]
fn undeleted_on_target_and_still_deleted_on_source_is_nothing() {
    let (id, mut base, _, _) = one_card("A");
    base.apply(&delete(id)).unwrap();
    let source = base.clone();
    let mut target = base.clone();
    apply_all(&mut target, &[undelete(id), set(id, "title", text("T"))]);

    assert_eq!(three_way(&base, &source, &target), (vec![], vec![]));
}

#[test]
fn undeleted_on_both_sides_compares_fields_against_the_tombstone() {
    let (id, mut base, _, _) = one_card("A");
    base.apply(&delete(id)).unwrap();
    let mut source = base.clone();
    let mut target = base.clone();
    apply_all(
        &mut source,
        &[undelete(id), set(id, "summary", text("from source"))],
    );
    apply_all(&mut target, &[undelete(id), set(id, "title", text("T"))]);

    assert_eq!(
        three_way(&base, &source, &target),
        (vec![set(id, "summary", text("from source"))], vec![])
    );
}

#[test]
fn connection_to_a_card_the_target_deleted_still_merges() {
    let (a, create_a) = card("A");
    let (z, create_z) = card("Z");
    let mut base = Board::new();
    apply_all(&mut base, &[create_a, create_z]);
    let mut source = base.clone();
    let (link, create_link) = connect(a, z);
    source.apply(&create_link).unwrap();
    let mut target = base.clone();
    target.apply(&delete(z)).unwrap();

    let (auto, conflicts) = three_way(&base, &source, &target);
    assert_eq!(auto, vec![create_link]);
    assert!(conflicts.is_empty());
    for op in &auto {
        assert!(target.apply(op).is_ok(), "{op:?} rejected");
    }
    assert!(!target.is_visible(link));
    target.apply(&undelete(z)).unwrap();
    assert!(target.is_visible(link));
}

#[test]
fn conflicts_are_ordered_by_key() {
    let (a, create_a) = card("A");
    let (b, create_b) = card("B");
    let mut base = Board::new();
    apply_all(&mut base, &[create_a, create_b]);
    let mut source = base.clone();
    let mut target = base.clone();
    apply_all(
        &mut source,
        &[
            set(a, "title", text("sa")),
            set(a, "summary", text("ss")),
            delete(b),
        ],
    );
    apply_all(
        &mut target,
        &[
            set(a, "title", text("ta")),
            set(a, "summary", text("ts")),
            set(b, "title", text("tb")),
        ],
    );

    let (auto, conflicts) = three_way(&base, &source, &target);
    assert!(auto.is_empty());
    let keys: Vec<ConflictKey> = conflicts.iter().map(Conflict::key).collect();
    let mut sorted = keys.clone();
    sorted.sort();
    assert_eq!(keys, sorted);
    assert_eq!(keys.len(), 3);
    assert!(keys.contains(&ConflictKey {
        entity: b,
        field: None
    }));
}

proptest::proptest! {
    #[test]
    fn untouched_target_ends_up_equal_to_source(a in bytes(), b in bytes()) {
        let mut base = Board::new();
        scribble(&mut base, &a);
        let mut source = base.clone();
        scribble(&mut source, &b);
        let mut target = base.clone();

        let (auto, conflicts) = three_way(&base, &source, &target);
        proptest::prop_assert!(conflicts.is_empty());
        for op in &auto {
            proptest::prop_assert!(target.apply(op).is_ok(), "{:?} rejected", op);
        }
        proptest::prop_assert!(target.same_content(&source));
    }

    #[test]
    fn untouched_source_changes_nothing(a in bytes(), b in bytes()) {
        let mut base = Board::new();
        scribble(&mut base, &a);
        let source = base.clone();
        let mut target = base.clone();
        scribble(&mut target, &b);

        proptest::prop_assert_eq!(three_way(&base, &source, &target), (vec![], vec![]));
    }

    #[test]
    fn automatic_ops_always_apply_to_a_diverged_target(a in bytes(), b in bytes(), c in bytes()) {
        let mut base = Board::new();
        scribble(&mut base, &a);
        let mut source = base.clone();
        scribble(&mut source, &b);
        let mut target = base.clone();
        scribble(&mut target, &c);

        let (auto, conflicts) = three_way(&base, &source, &target);
        for op in &auto {
            proptest::prop_assert!(target.apply(op).is_ok(), "{:?} rejected", op);
        }
        let keys: Vec<ConflictKey> = conflicts.iter().map(Conflict::key).collect();
        let mut sorted = keys.clone();
        sorted.sort();
        sorted.dedup();
        proptest::prop_assert_eq!(keys, sorted);
    }
}

#[test]
fn connection_kind_changed_both_ways_is_a_field_conflict() {
    let (a, create_a) = card("A");
    let (b, create_b) = card("B");
    let (link, create_link) = connect(a, b);
    let mut base = Board::new();
    for op in [create_a, create_b, create_link] {
        base.apply(&op).unwrap();
    }
    let (mut source, mut target) = (base.clone(), base.clone());
    source.apply(&set(link, "kind", text("directed"))).unwrap();
    target
        .apply(&set(link, "kind", text("contradicts")))
        .unwrap();

    let (auto, conflicts) = three_way(&base, &source, &target);
    assert!(auto.is_empty());
    assert_eq!(
        conflicts,
        vec![Conflict::Field {
            entity: link,
            field: "kind".to_string(),
            base: Value::Null,
            source: text("directed"),
            target: text("contradicts"),
        }]
    );
}
