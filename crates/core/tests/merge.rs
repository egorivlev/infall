mod common;

use common::*;
use qoop_core::*;

struct Ids {
    me: MemberId,
    surface: EntityId,
    grover: EntityId,
    vqe: EntityId,
    thresholds: EntityId,
}

/// main: "Surface codes", "Grover search", "VQE notes"; fork try-QEC from main's head; then
/// main: title -> "Surface codes (review)", Grover x -> 300, VQE summary -> "main summary";
/// try-QEC: title -> "Surface & toric codes", Delete Grover, VQE color -> "blue", create "QEC thresholds".
fn diverged() -> (Workspace, BranchId, BranchId, Ids) {
    let (mut ws, main) = Workspace::new();
    let me = MemberId::new();
    let (surface, create_surface) = card("Surface codes");
    let (grover, create_grover) = card("Grover search");
    let (vqe, create_vqe) = card("VQE notes");
    for op in [create_surface, create_grover, create_vqe] {
        ws.record(main, me, 1, op).unwrap();
    }
    let qec = ws.fork("try-QEC", ws.head(main).unwrap(), me, 2).unwrap();
    for op in [
        set(surface, "title", text("Surface codes (review)")),
        set(grover, "x", Value::Float(300.0)),
        set(vqe, "summary", text("main summary")),
    ] {
        ws.record(main, me, 3, op).unwrap();
    }
    let (thresholds, create_thresholds) = card("QEC thresholds");
    for op in [
        set(surface, "title", text("Surface & toric codes")),
        Op::Delete { entity: grover },
        set(vqe, "color", text("blue")),
        create_thresholds,
    ] {
        ws.record(qec, me, 4, op).unwrap();
    }
    let ids = Ids {
        me,
        surface,
        grover,
        vqe,
        thresholds,
    };
    (ws, main, qec, ids)
}

fn title_key(ids: &Ids) -> ConflictKey {
    ConflictKey {
        entity: ids.surface,
        field: Some("title".to_string()),
    }
}

fn entity_key(entity: EntityId) -> ConflictKey {
    ConflictKey {
        entity,
        field: None,
    }
}

fn decide_all(plan: &MergePlan, decision: Decision) -> Decisions {
    plan.conflicts
        .iter()
        .map(|c| (c.key(), decision.clone()))
        .collect()
}

fn head_board(ws: &Workspace, branch: BranchId) -> Board {
    ws.board_at(ws.head(branch).unwrap()).unwrap()
}

fn change_count(ws: &Workspace, branch: BranchId) -> usize {
    ws.branch(branch).unwrap().changes().len()
}

fn merge(ws: &mut Workspace, source: BranchId, target: BranchId, me: MemberId, decision: Decision) {
    let plan = ws.plan_merge(source, target).unwrap();
    let decisions = decide_all(&plan, decision);
    ws.apply_merge(&plan, &decisions, me, 10).unwrap();
}

#[test]
fn the_review_lists_automatic_changes_and_conflicts() {
    let (ws, main, qec, ids) = diverged();
    let plan = ws.plan_merge(qec, main).unwrap();
    assert_eq!(plan.source, ws.head(qec).unwrap());
    assert_eq!(plan.target, ws.head(main).unwrap());
    assert_eq!(Some(plan.base), ws.branch(qec).unwrap().parent());
    assert_eq!(
        plan.conflicts,
        vec![Conflict::Field {
            entity: ids.surface,
            field: "title".to_string(),
            base: text("Surface codes"),
            source: text("Surface & toric codes"),
            target: text("Surface codes (review)"),
        }]
    );
    let mut fields = Fields::new();
    fields.insert("title".to_string(), text("QEC thresholds"));
    assert_eq!(
        plan.auto,
        vec![
            Op::Create {
                entity: ids.thresholds,
                kind: EntityKind::Card,
                fields,
            },
            set(ids.vqe, "color", text("blue")),
            Op::Delete { entity: ids.grover },
        ]
    );
}

#[test]
fn applying_needs_every_conflict_decided() {
    let (mut ws, main, qec, ids) = diverged();
    let plan = ws.plan_merge(qec, main).unwrap();
    let before = ws.clone();
    assert_eq!(
        ws.apply_merge(&plan, &Decisions::new(), ids.me, 10),
        Err(MergeError::Undecided(vec![title_key(&ids)]))
    );
    assert_eq!(ws, before);
}

#[test]
fn a_decided_merge_lands_as_one_batch() {
    let (mut ws, main, qec, ids) = diverged();
    let qec_changes = ws.branch(qec).unwrap().changes().to_vec();
    let before = change_count(&ws, main);
    let plan = ws.plan_merge(qec, main).unwrap();
    let decisions: Decisions = [(
        title_key(&ids),
        Decision::Custom(text("Surface & toric codes (review)")),
    )]
    .into_iter()
    .collect();
    let head = ws.apply_merge(&plan, &decisions, ids.me, 10).unwrap();
    assert_eq!(head, ws.head(main).unwrap());

    let board = head_board(&ws, main);
    let surface = board.get(ids.surface).unwrap();
    assert_eq!(
        surface.get("title"),
        &text("Surface & toric codes (review)")
    );
    let vqe = board.get(ids.vqe).unwrap();
    assert_eq!(vqe.get("summary"), &text("main summary"));
    assert_eq!(vqe.get("color"), &text("blue"));
    assert!(board.get(ids.grover).unwrap().deleted);
    assert!(board.is_visible(ids.thresholds));

    let appended = &ws.branch(main).unwrap().changes()[before..];
    assert_eq!(appended.len(), plan.auto.len() + 1);
    let batch = match appended[0].origin {
        Origin::Merge { batch, source } => {
            assert_eq!(source, plan.source);
            batch
        }
        ref other => panic!("not a merge: {other:?}"),
    };
    for change in appended {
        assert_eq!(
            change.origin,
            Origin::Merge {
                batch,
                source: plan.source
            }
        );
    }
    assert_eq!(ws.branch(qec).unwrap().changes(), &qec_changes[..]);
}

#[test]
fn merging_again_straight_away_finds_nothing() {
    let (mut ws, main, qec, ids) = diverged();
    merge(&mut ws, qec, main, ids.me, Decision::TakeSource);
    let plan = ws.plan_merge(qec, main).unwrap();
    assert!(plan.auto.is_empty());
    assert!(plan.conflicts.is_empty());
}

#[test]
fn later_work_on_the_branch_merges_without_repeating_old_conflicts() {
    let (mut ws, main, qec, ids) = diverged();
    merge(&mut ws, qec, main, ids.me, Decision::TakeTarget);
    ws.record(qec, ids.me, 11, set(ids.thresholds, "summary", text("new")))
        .unwrap();
    let plan = ws.plan_merge(qec, main).unwrap();
    assert_eq!(plan.auto, vec![set(ids.thresholds, "summary", text("new"))]);
    assert!(plan.conflicts.is_empty());
}

#[test]
fn the_parent_can_be_merged_into_the_child() {
    let (ws, main, qec, ids) = diverged();
    let plan = ws.plan_merge(main, qec).unwrap();
    assert_eq!(plan.source, ws.head(main).unwrap());
    assert_eq!(plan.target, ws.head(qec).unwrap());
    assert_eq!(
        plan.conflicts,
        vec![Conflict::Field {
            entity: ids.surface,
            field: "title".to_string(),
            base: text("Surface codes"),
            source: text("Surface codes (review)"),
            target: text("Surface & toric codes"),
        }]
    );
    assert_eq!(
        plan.auto,
        vec![set(ids.vqe, "summary", text("main summary"))]
    );
}

#[test]
fn a_merge_into_the_child_is_remembered_on_the_child() {
    let (mut ws, main, qec, ids) = diverged();
    let main_head = ws.head(main).unwrap();
    merge(&mut ws, main, qec, ids.me, Decision::TakeTarget);
    assert_eq!(
        ws.branch(qec).unwrap().sync_points().last(),
        Some(&SyncPoint {
            base: main_head,
            landed: Some(ws.head(qec).unwrap()),
        })
    );
    assert!(ws.branch(main).unwrap().sync_points().is_empty());
    let plan = ws.plan_merge(qec, main).unwrap();
    assert!(plan.conflicts.is_empty());
}

#[test]
fn siblings_cannot_be_merged_directly() {
    let (mut ws, main, qec, ids) = diverged();
    let other = ws.fork("other", ws.head(main).unwrap(), ids.me, 5).unwrap();
    assert_eq!(
        ws.plan_merge(qec, other),
        Err(MergeError::NotParentAndChild)
    );
    assert_eq!(
        ws.plan_merge(other, qec),
        Err(MergeError::NotParentAndChild)
    );
    assert_eq!(ws.plan_merge(qec, qec), Err(MergeError::NotParentAndChild));
    assert_eq!(
        ws.plan_merge(main, main),
        Err(MergeError::NotParentAndChild)
    );
}

#[test]
fn a_plan_goes_stale_when_the_target_moves() {
    let (mut ws, main, qec, ids) = diverged();
    let plan = ws.plan_merge(qec, main).unwrap();
    let decisions = decide_all(&plan, Decision::TakeSource);
    let (late, create_late) = card("Late arrival");
    ws.record(main, ids.me, 9, create_late).unwrap();
    let before = ws.clone();
    assert_eq!(
        ws.apply_merge(&plan, &decisions, ids.me, 10),
        Err(MergeError::Stale)
    );
    assert_eq!(ws, before);
    assert!(head_board(&ws, main).is_visible(late));

    let (mut ws, main, qec, ids) = diverged();
    let plan = ws.plan_merge(qec, main).unwrap();
    let decisions = decide_all(&plan, Decision::TakeSource);
    ws.record(qec, ids.me, 9, card("Late on the branch").1)
        .unwrap();
    let before = ws.clone();
    assert_eq!(
        ws.apply_merge(&plan, &decisions, ids.me, 10),
        Err(MergeError::Stale)
    );
    assert_eq!(ws, before);
}

#[test]
fn an_undone_merge_can_be_merged_again() {
    let (mut ws, main, qec, ids) = diverged();
    let before = ws.head(main).unwrap().seq;
    let first = ws.plan_merge(qec, main).unwrap();
    ws.apply_merge(
        &first,
        &decide_all(&first, Decision::TakeSource),
        ids.me,
        10,
    )
    .unwrap();
    ws.restore(main, before, ids.me, 11).unwrap();
    assert!(!head_board(&ws, main).is_visible(ids.thresholds));

    let again = ws.plan_merge(qec, main).unwrap();
    assert_eq!(again.conflicts, first.conflicts);
    assert!(!again.auto.is_empty());
    ws.apply_merge(
        &again,
        &decide_all(&again, Decision::TakeSource),
        ids.me,
        12,
    )
    .unwrap();
    let board = head_board(&ws, main);
    assert!(board.is_visible(ids.thresholds));
    assert!(board.get(ids.grover).unwrap().deleted);
    assert_eq!(board.get(ids.vqe).unwrap().get("color"), &text("blue"));
    assert_eq!(
        board.get(ids.surface).unwrap().get("title"),
        &text("Surface & toric codes")
    );
}

#[test]
fn an_undone_merge_comes_back_even_when_the_restore_appends_nothing() {
    // main: A (seq 1); fork; branch retitles A; merge lands at main seq 2;
    // main retitles A back by hand (seq 3); restore main to 1 appends nothing.
    let (mut ws, main) = Workspace::new();
    let me = MemberId::new();
    let (a, create_a) = card("A");
    ws.record(main, me, 1, create_a).unwrap();
    let side = ws.fork("side", ws.head(main).unwrap(), me, 2).unwrap();
    ws.record(side, me, 3, set(a, "title", text("Q"))).unwrap();
    merge(&mut ws, side, main, me, Decision::TakeSource);
    ws.record(main, me, 4, set(a, "title", text("A"))).unwrap();
    assert_eq!(ws.restore(main, 1, me, 5).unwrap().seq, 3);

    let plan = ws.plan_merge(side, main).unwrap();
    assert_eq!(plan.auto, vec![set(a, "title", text("Q"))]);
}

#[test]
fn an_invalid_hand_written_value_refuses_the_whole_merge() {
    let (mut ws, main, qec, ids) = diverged();
    let plan = ws.plan_merge(qec, main).unwrap();
    let decisions: Decisions = [(title_key(&ids), Decision::Custom(Value::Float(1.0)))]
        .into_iter()
        .collect();
    let before = ws.clone();
    assert!(matches!(
        ws.apply_merge(&plan, &decisions, ids.me, 10),
        Err(MergeError::Ws(WsError::Apply(ApplyError::Schema(_))))
    ));
    assert_eq!(change_count(&ws, main), change_count(&before, main));
    assert_eq!(
        ws.branch(qec).unwrap().sync_points(),
        before.branch(qec).unwrap().sync_points()
    );
    assert_eq!(ws, before);
}

#[test]
fn decisions_must_match_the_conflicts() {
    let (mut ws, main, qec, ids) = diverged();
    ws.record(qec, ids.me, 5, Op::Delete { entity: ids.vqe })
        .unwrap();
    let plan = ws.plan_merge(qec, main).unwrap();
    assert_eq!(plan.conflicts.len(), 2);

    let mut extra = decide_all(&plan, Decision::TakeSource);
    extra.insert(entity_key(ids.thresholds), Decision::TakeSource);
    assert_eq!(
        ws.apply_merge(&plan, &extra, ids.me, 10),
        Err(MergeError::UnknownConflict(entity_key(ids.thresholds)))
    );

    let mut custom = decide_all(&plan, Decision::TakeSource);
    custom.insert(entity_key(ids.vqe), Decision::Custom(text("whatever")));
    assert_eq!(
        ws.apply_merge(&plan, &custom, ids.me, 10),
        Err(MergeError::CustomNotAllowed(entity_key(ids.vqe)))
    );
}

#[test]
fn edit_versus_delete_goes_whichever_way_is_decided() {
    // The branch deletes "VQE notes" while main edited its summary.
    for (decision, deleted) in [(Decision::TakeSource, true), (Decision::TakeTarget, false)] {
        let (mut ws, main, qec, ids) = diverged();
        ws.record(qec, ids.me, 5, Op::Delete { entity: ids.vqe })
            .unwrap();
        let plan = ws.plan_merge(qec, main).unwrap();
        assert!(plan.conflicts.contains(&Conflict::EditVsDelete {
            entity: ids.vqe,
            deleted_on: Side::Source,
        }));
        merge(&mut ws, qec, main, ids.me, decision);
        let board = head_board(&ws, main);
        let vqe = board.get(ids.vqe).unwrap();
        assert_eq!(vqe.deleted, deleted);
        if !deleted {
            assert_eq!(vqe.get("summary"), &text("main summary"));
        }
    }

    // Main deletes "VQE notes" while the branch retitled it.
    for (decision, deleted) in [(Decision::TakeSource, false), (Decision::TakeTarget, true)] {
        let (mut ws, main, qec, ids) = diverged();
        ws.record(main, ids.me, 5, Op::Delete { entity: ids.vqe })
            .unwrap();
        ws.record(qec, ids.me, 5, set(ids.vqe, "title", text("VQE (qec)")))
            .unwrap();
        let plan = ws.plan_merge(qec, main).unwrap();
        assert!(plan.conflicts.contains(&Conflict::EditVsDelete {
            entity: ids.vqe,
            deleted_on: Side::Target,
        }));
        merge(&mut ws, qec, main, ids.me, decision);
        let board = head_board(&ws, main);
        let vqe = board.get(ids.vqe).unwrap();
        assert_eq!(vqe.deleted, deleted);
        if !deleted {
            // Live with exactly the branch's content fields.
            assert_eq!(vqe.get("title"), &text("VQE (qec)"));
            assert_eq!(vqe.get("color"), &text("blue"));
            assert_eq!(vqe.get("summary"), &Value::Null);
        }
    }
}

#[test]
fn a_merge_with_nothing_to_do_still_records_where_the_branches_met() {
    let (mut ws, main) = Workspace::new();
    let me = MemberId::new();
    ws.record(main, me, 1, card("A").1).unwrap();
    let side = ws.fork("side", ws.head(main).unwrap(), me, 2).unwrap();
    ws.record(main, me, 3, card("B").1).unwrap();
    let plan = ws.plan_merge(side, main).unwrap();
    assert!(plan.auto.is_empty() && plan.conflicts.is_empty());
    let head = ws.apply_merge(&plan, &Decisions::new(), me, 4).unwrap();
    assert_eq!(head, plan.target);
    assert_eq!(change_count(&ws, main), 2);
    assert_eq!(
        ws.branch(side).unwrap().sync_points().last(),
        Some(&SyncPoint {
            base: plan.source,
            landed: Some(plan.target),
        })
    );
}

/// main: A (seq 1); fork side; side creates T; side merged into main (lands main@2);
/// main sets A.summary (main@3); main merged into side (lands side@2).
fn merged_both_ways() -> (Workspace, BranchId, BranchId, MemberId, EntityId, EntityId) {
    let (mut ws, main) = Workspace::new();
    let me = MemberId::new();
    let (a, create_a) = card("A");
    ws.record(main, me, 1, create_a).unwrap();
    let side = ws.fork("side", ws.head(main).unwrap(), me, 2).unwrap();
    let (t, create_t) = card("T");
    ws.record(side, me, 3, create_t).unwrap();
    merge(&mut ws, side, main, me, Decision::TakeSource);
    assert_eq!(ws.head(main).unwrap().seq, 2);
    ws.record(main, me, 4, set(a, "summary", text("main summary")))
        .unwrap();
    merge(&mut ws, main, side, me, Decision::TakeSource);
    (ws, main, side, me, a, t)
}

#[test]
fn undoing_a_merge_forgets_later_merges_between_the_same_branches() {
    let (mut ws, main, side, me, _, t) = merged_both_ways();
    let fork_point = ws.branch(side).unwrap().sync_points()[0].clone();
    assert_eq!(fork_point.landed, None);
    ws.restore(main, 1, me, 5).unwrap();
    assert_eq!(ws.branch(side).unwrap().sync_points(), &[fork_point]);

    let mut back = ws.clone();
    let plan = back.plan_merge(side, main).unwrap();
    assert!(plan.conflicts.is_empty());
    back.apply_merge(&plan, &Decisions::new(), me, 6).unwrap();
    assert!(head_board(&back, main).is_visible(t));

    let plan = ws.plan_merge(main, side).unwrap();
    assert!(!plan.auto.contains(&Op::Delete { entity: t }));
    let decisions = decide_all(&plan, Decision::TakeTarget);
    ws.apply_merge(&plan, &decisions, me, 6).unwrap();
    assert!(head_board(&ws, side).is_visible(t));
}

#[test]
fn restoring_a_branchs_own_work_keeps_the_merge_history() {
    let (mut ws, main) = Workspace::new();
    let me = MemberId::new();
    ws.record(main, me, 1, card("A").1).unwrap();
    let side = ws.fork("side", ws.head(main).unwrap(), me, 2).unwrap();
    ws.record(side, me, 3, card("T").1).unwrap();
    merge(&mut ws, side, main, me, Decision::TakeSource);
    let landed = ws.head(main).unwrap().seq;
    ws.record(main, me, 4, card("M").1).unwrap();
    let points = ws.branch(side).unwrap().sync_points().to_vec();
    assert_eq!(points.len(), 2);

    ws.restore(main, landed, me, 5).unwrap();
    assert_eq!(ws.branch(side).unwrap().sync_points(), &points[..]);
    let plan = ws.plan_merge(side, main).unwrap();
    assert!(plan.auto.is_empty());
    assert!(plan.conflicts.is_empty());
}

#[test]
fn restoring_the_child_to_before_a_merge_from_the_parent_forgets_it_and_later_ones() {
    // main: A; fork side; main sets A.summary; side creates T;
    // main merged into side (lands side@2); side merged into main (lands main@3).
    let (mut ws, main) = Workspace::new();
    let me = MemberId::new();
    let (a, create_a) = card("A");
    ws.record(main, me, 1, create_a).unwrap();
    let side = ws.fork("side", ws.head(main).unwrap(), me, 2).unwrap();
    ws.record(main, me, 3, set(a, "summary", text("main summary")))
        .unwrap();
    ws.record(side, me, 3, card("T").1).unwrap();
    merge(&mut ws, main, side, me, Decision::TakeSource);
    assert_eq!(ws.head(side).unwrap().seq, 2);
    merge(&mut ws, side, main, me, Decision::TakeSource);
    assert_eq!(ws.branch(side).unwrap().sync_points().len(), 3);
    let fork_point = ws.branch(side).unwrap().sync_points()[0].clone();

    ws.restore(side, 1, me, 4).unwrap();
    assert_eq!(ws.branch(side).unwrap().sync_points(), &[fork_point]);
    // The parent's work comes back to the child when merged again.
    let plan = ws.plan_merge(main, side).unwrap();
    assert!(plan.conflicts.is_empty());
    assert!(plan.auto.contains(&set(a, "summary", text("main summary"))));
}

#[test]
fn a_plan_goes_stale_when_the_base_changes() {
    let (mut ws, main) = Workspace::new();
    let me = MemberId::new();
    let (a, create_a) = card("A");
    ws.record(main, me, 1, create_a).unwrap();
    let side = ws.fork("side", ws.head(main).unwrap(), me, 2).unwrap();
    ws.record(side, me, 3, set(a, "title", text("Q"))).unwrap();
    merge(&mut ws, side, main, me, Decision::TakeSource);
    ws.record(main, me, 4, set(a, "title", text("A"))).unwrap();
    let plan = ws.plan_merge(side, main).unwrap();
    assert!(plan.auto.is_empty());
    assert_eq!(ws.restore(main, 1, me, 5).unwrap().seq, 3);

    let before = ws.clone();
    assert_eq!(
        ws.apply_merge(&plan, &Decisions::new(), me, 6),
        Err(MergeError::Stale)
    );
    assert_eq!(ws, before);
}

#[test]
fn decisions_round_trip_through_json() {
    let (_, _, _, ids) = diverged();
    let decisions: Decisions = [
        (title_key(&ids), Decision::Custom(text("hand written"))),
        (entity_key(ids.vqe), Decision::TakeSource),
        (
            ConflictKey {
                entity: ids.grover,
                field: Some("x".to_string()),
            },
            Decision::Custom(Value::Null),
        ),
    ]
    .into_iter()
    .collect();
    let json = serde_json::to_string(&decisions).unwrap();
    let back: Decisions = serde_json::from_str(&json).unwrap();
    assert_eq!(back, decisions);
    assert_eq!(back.len(), 3);
    assert_eq!(
        back.get(&title_key(&ids)),
        Some(&Decision::Custom(text("hand written")))
    );
}

#[test]
fn decisions_with_a_repeated_conflict_are_rejected() {
    let (_, _, _, ids) = diverged();
    let one: Decisions = [(title_key(&ids), Decision::TakeSource)]
        .into_iter()
        .collect();
    let json = serde_json::to_string(&one).unwrap();
    assert_eq!(serde_json::from_str::<Decisions>(&json).unwrap(), one);

    let entry = serde_json::to_value((title_key(&ids), Decision::TakeSource)).unwrap();
    let entry_other = serde_json::to_value((title_key(&ids), Decision::TakeTarget)).unwrap();
    let repeated = serde_json::Value::Array(vec![entry, entry_other]).to_string();
    assert!(serde_json::from_str::<Decisions>(&repeated).is_err());
}

#[test]
fn a_plan_with_its_conflicts_removed_is_refused() {
    let (mut ws, main, qec, ids) = diverged();
    let mut plan = ws.plan_merge(qec, main).unwrap();
    assert!(!plan.conflicts.is_empty());
    plan.conflicts.clear();
    let before = ws.clone();
    assert_eq!(
        ws.apply_merge(&plan, &Decisions::new(), ids.me, 10),
        Err(MergeError::Stale)
    );
    assert_eq!(ws, before);
}

#[test]
fn a_plan_with_altered_automatic_changes_is_refused() {
    let (mut ws, main, qec, ids) = diverged();
    let plan = ws.plan_merge(qec, main).unwrap();
    let decisions = decide_all(&plan, Decision::TakeSource);
    let before = ws.clone();

    let mut dropped = plan.clone();
    dropped
        .auto
        .retain(|op| *op != Op::Delete { entity: ids.grover });
    assert_eq!(dropped.auto.len() + 1, plan.auto.len());
    assert_eq!(
        ws.apply_merge(&dropped, &decisions, ids.me, 10),
        Err(MergeError::Stale)
    );
    assert_eq!(ws, before);

    let mut added = plan.clone();
    added.auto.push(Op::Delete { entity: ids.vqe });
    assert_eq!(
        ws.apply_merge(&added, &decisions, ids.me, 10),
        Err(MergeError::Stale)
    );
    assert_eq!(ws, before);

    ws.apply_merge(&plan, &decisions, ids.me, 10).unwrap();
}

/// Pins a documented limitation (spec §5 "Known limitation"): forgetting a later Merge in
/// the chain leaves its content on both Branches with no record that they agreed, so the
/// next Merge reverses a deliberate Undelete automatically. If this test starts failing
/// because the limitation was removed, update the spec with it.
#[test]
fn known_limitation_a_forgotten_later_merge_can_reverse_an_undelete() {
    // main: Y; fork child; child creates C; S1 child->main (lands main@2); main creates M;
    // child deletes Y; S2 main->child (lands child@3); S3 child->main deletes Y on main.
    let (mut ws, main) = Workspace::new();
    let me = MemberId::new();
    let (y, create_y) = card("Y");
    ws.record(main, me, 1, create_y).unwrap();
    let child = ws.fork("child", ws.head(main).unwrap(), me, 2).unwrap();
    ws.record(child, me, 3, card("C").1).unwrap();
    merge(&mut ws, child, main, me, Decision::TakeSource);
    ws.record(main, me, 4, card("M").1).unwrap();
    ws.record(child, me, 5, Op::Delete { entity: y }).unwrap();
    let before_s2 = ws.head(child).unwrap().seq;
    merge(&mut ws, main, child, me, Decision::TakeSource);
    assert!(ws.head(child).unwrap().seq > before_s2);
    merge(&mut ws, child, main, me, Decision::TakeSource);
    assert!(head_board(&ws, main).get(y).unwrap().deleted);

    // Child Restores to before S2 landed: S2 and S3 are forgotten, Y stays deleted on both.
    ws.restore(child, before_s2, me, 6).unwrap();
    assert_eq!(ws.branch(child).unwrap().sync_points().len(), 2);
    // A Member on main deliberately brings Y back.
    ws.record(main, me, 7, Op::Undelete { entity: y }).unwrap();

    let plan = ws.plan_merge(child, main).unwrap();
    assert!(plan.conflicts.is_empty());
    assert_eq!(plan.auto, vec![Op::Delete { entity: y }]);
}

#[test]
fn a_workspace_with_merges_both_ways_round_trips_through_json() {
    let (mut ws, main, qec, ids) = diverged();
    let plan = ws.plan_merge(qec, main).unwrap();
    assert!(!plan.conflicts.is_empty());
    merge(&mut ws, qec, main, ids.me, Decision::TakeSource);
    ws.checkpoint("after QEC", ws.head(main).unwrap(), ids.me, 11)
        .unwrap();
    ws.record(main, ids.me, 12, set(ids.vqe, "summary", text("newer")))
        .unwrap();
    merge(&mut ws, main, qec, ids.me, Decision::TakeSource);
    ws.record(qec, ids.me, 13, card("After sync").1).unwrap();
    ws.restore(qec, 2, ids.me, 14).unwrap();

    let json = serde_json::to_string(&ws).unwrap();
    let copy: Workspace = serde_json::from_str(&json).unwrap();
    assert_eq!(copy, ws);
    for (source, target) in [(qec, main), (main, qec)] {
        let plan = ws.plan_merge(source, target).unwrap();
        assert_eq!(copy.plan_merge(source, target).unwrap(), plan);
        let plan_json = serde_json::to_string(&plan).unwrap();
        assert_eq!(serde_json::from_str::<MergePlan>(&plan_json).unwrap(), plan);
    }
}

#[test]
fn a_connection_retargeted_on_both_sides_must_keep_an_endpoint() {
    // main: A, B, C, D and A -> B; fork; main points it at C, the branch at D.
    let (mut ws, main) = Workspace::new();
    let me = MemberId::new();
    let (a, create_a) = card("A");
    let (b, create_b) = card("B");
    let (c, create_c) = card("C");
    let (d, create_d) = card("D");
    let (link, create_link) = connect(a, b);
    for op in [create_a, create_b, create_c, create_d, create_link] {
        ws.record(main, me, 1, op).unwrap();
    }
    let side = ws.fork("side", ws.head(main).unwrap(), me, 2).unwrap();
    ws.record(main, me, 3, set(link, "to", Value::Ref(c)))
        .unwrap();
    ws.record(side, me, 3, set(link, "to", Value::Ref(d)))
        .unwrap();
    let plan = ws.plan_merge(side, main).unwrap();
    let key = ConflictKey {
        entity: link,
        field: Some("to".to_string()),
    };
    assert_eq!(
        plan.conflicts.iter().map(Conflict::key).collect::<Vec<_>>(),
        vec![key.clone()]
    );

    let cleared: Decisions = [(key.clone(), Decision::Custom(Value::Null))]
        .into_iter()
        .collect();
    let before = ws.clone();
    assert_eq!(
        ws.apply_merge(&plan, &cleared, me, 4),
        Err(MergeError::Ws(WsError::Apply(ApplyError::MissingEndpoint(
            link
        ))))
    );
    assert_eq!(ws, before);

    let source: Decisions = [(key, Decision::TakeSource)].into_iter().collect();
    ws.apply_merge(&plan, &source, me, 4).unwrap();
    let board = head_board(&ws, main);
    assert_eq!(board.get(link).unwrap().get("to"), &Value::Ref(d));
    assert!(board.is_visible(link));
}

#[test]
fn a_connection_to_a_card_deleted_on_the_other_branch_waits_for_it() {
    // main: A, B; fork; main draws A -> B while the branch deletes B.
    let setup = || {
        let (mut ws, main) = Workspace::new();
        let me = MemberId::new();
        let (a, create_a) = card("A");
        let (b, create_b) = card("B");
        ws.record(main, me, 1, create_a).unwrap();
        ws.record(main, me, 1, create_b).unwrap();
        let side = ws.fork("side", ws.head(main).unwrap(), me, 2).unwrap();
        let (link, create_link) = connect(a, b);
        ws.record(main, me, 3, create_link).unwrap();
        ws.record(side, me, 3, Op::Delete { entity: b }).unwrap();
        (ws, main, side, me, b, link)
    };

    // The Connection arrives on the Branch that deleted B, and the reverse.
    for into_side in [true, false] {
        let (mut ws, main, side, me, b, link) = setup();
        let (source, target) = if into_side {
            (main, side)
        } else {
            (side, main)
        };
        let plan = ws.plan_merge(source, target).unwrap();
        assert!(plan.conflicts.is_empty());
        ws.apply_merge(&plan, &Decisions::new(), me, 4).unwrap();
        let board = head_board(&ws, target);
        assert!(board.get(b).unwrap().deleted);
        assert!(board.get(link).is_some_and(|l| !l.deleted));
        assert!(!board.is_visible(link));

        ws.record(target, me, 5, Op::Undelete { entity: b })
            .unwrap();
        assert!(head_board(&ws, target).is_visible(link));
    }
}
