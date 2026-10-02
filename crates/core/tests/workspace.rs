mod common;
use common::*;
use qoop_core::*;

fn title_at(ws: &Workspace, moment: Moment, id: EntityId) -> Option<Value> {
    ws.board_at(moment)
        .unwrap()
        .get(id)
        .map(|e| e.get("title").clone())
}

#[test]
fn recording_advances_the_head_and_rejections_do_not() {
    let (mut ws, main) = Workspace::new();
    let me = MemberId::new();
    let (id, op) = card("A");
    assert_eq!(ws.head(main).unwrap().seq, 0);
    assert_eq!(
        ws.record(main, me, 1, op.clone()).unwrap(),
        Moment {
            branch: main,
            seq: 1
        }
    );
    assert!(matches!(
        ws.record(main, me, 2, op),
        Err(WsError::Apply(ApplyError::AlreadyExists(_)))
    ));
    assert_eq!(ws.head(main).unwrap().seq, 1);
    let c = &ws.branch(main).unwrap().changes()[0];
    assert_eq!((c.author, c.at, &c.origin), (me, 1, &Origin::Edit));
    assert!(
        ws.board_at(Moment {
            branch: main,
            seq: 0
        })
        .unwrap()
        .get(id)
        .is_none()
    );
}

#[test]
fn a_fork_starts_from_its_parent_moment_and_then_diverges() {
    let (mut ws, main) = Workspace::new();
    let me = MemberId::new();
    let (a, op) = card("A");
    ws.record(main, me, 1, op).unwrap();
    ws.record(main, me, 2, set(a, "title", text("A2"))).unwrap();
    let fork_point = Moment {
        branch: main,
        seq: 1,
    };
    let b = ws.fork("try-QEC", fork_point, me, 3).unwrap();
    let b_head = ws.head(b).unwrap();
    assert_eq!(b_head, Moment { branch: b, seq: 0 });
    assert_eq!(title_at(&ws, b_head, a), Some(text("A")));

    ws.record(b, me, 4, set(a, "title", text("B"))).unwrap();
    assert_eq!(title_at(&ws, ws.head(b).unwrap(), a), Some(text("B")));
    assert_eq!(title_at(&ws, ws.head(main).unwrap(), a), Some(text("A2")));

    let (c, cop) = card("C");
    ws.record(main, me, 5, cop).unwrap();
    assert_eq!(title_at(&ws, ws.head(b).unwrap(), c), None);

    let branch = ws.branch(b).unwrap();
    assert_eq!(branch.parent(), Some(fork_point));
    assert_eq!(
        branch.sync_points(),
        &[SyncPoint {
            base: fork_point,
            landed: None
        }]
    );
    assert_eq!(branch.name(), "try-QEC");
    assert_eq!(
        (branch.created_by(), branch.created_at()),
        (Some(me), Some(3))
    );
    let m = ws.branch(main).unwrap();
    assert_eq!((m.created_by(), m.created_at()), (None, None));
    assert_eq!(ws.branch_by_name("try-QEC").unwrap().id(), b);
    assert_eq!(ws.branch(main).unwrap().parent(), None);
    assert_eq!(ws.branches().count(), 2);
}

#[test]
fn a_fork_of_a_fork_replays_through_both_parents() {
    let (mut ws, main) = Workspace::new();
    let me = MemberId::new();
    let (a, op) = card("A");
    ws.record(main, me, 1, op).unwrap();
    let b1 = ws
        .fork(
            "b1",
            Moment {
                branch: main,
                seq: 1,
            },
            me,
            2,
        )
        .unwrap();
    let (b, op) = card("B");
    ws.record(b1, me, 3, op).unwrap();
    let b2 = ws.fork("b2", Moment { branch: b1, seq: 1 }, me, 4).unwrap();
    let (c, op) = card("C");
    ws.record(b2, me, 5, op).unwrap();
    let board = ws.board_at(ws.head(b2).unwrap()).unwrap();
    assert!(board.get(a).is_some() && board.get(b).is_some() && board.get(c).is_some());
}

#[test]
fn branch_names_are_unique_and_non_empty() {
    let (mut ws, main) = Workspace::new();
    let me = MemberId::new();
    let (_, op) = card("A");
    ws.record(main, me, 1, op).unwrap();
    let at = Moment {
        branch: main,
        seq: 1,
    };
    assert_eq!(
        ws.fork("main", at, me, 2),
        Err(WsError::NameTaken("main".to_string()))
    );
    assert_eq!(
        ws.fork(" main ", at, me, 2),
        Err(WsError::NameTaken("main".to_string()))
    );
    assert_eq!(ws.fork("  ", at, me, 2), Err(WsError::EmptyName));
    let far = Moment {
        branch: main,
        seq: 99,
    };
    assert_eq!(ws.fork("x", far, me, 2), Err(WsError::BadMoment(far)));
    let ghost = Moment {
        branch: BranchId::new(),
        seq: 0,
    };
    assert_eq!(
        ws.fork("y", ghost, me, 2),
        Err(WsError::UnknownBranch(ghost.branch))
    );
    assert_eq!(ws.branches().count(), 1);
}

#[test]
fn checkpoints_name_moments() {
    let (mut ws, main) = Workspace::new();
    let me = MemberId::new();
    ws.record(main, me, 1, card("A").1).unwrap();
    ws.record(main, me, 2, card("B").1).unwrap();
    let m1 = Moment {
        branch: main,
        seq: 1,
    };
    let m2 = Moment {
        branch: main,
        seq: 2,
    };
    ws.checkpoint("zeta", m2, me, 3).unwrap();
    ws.checkpoint("before prof meeting", m1, me, 4).unwrap();
    assert_eq!(
        ws.checkpoint("before prof meeting", m2, me, 5),
        Err(WsError::NameTaken("before prof meeting".to_string()))
    );
    assert_eq!(ws.checkpoint(" ", m1, me, 5), Err(WsError::EmptyName));
    let other = ws.fork("other", m1, me, 6).unwrap();
    ws.checkpoint(
        "before prof meeting",
        Moment {
            branch: other,
            seq: 0,
        },
        me,
        7,
    )
    .unwrap();
    let far = Moment {
        branch: main,
        seq: 99,
    };
    assert_eq!(
        ws.checkpoint("late", far, me, 8),
        Err(WsError::BadMoment(far))
    );
    let names: Vec<(&str, u64)> = ws
        .checkpoints(main)
        .iter()
        .map(|c| (c.name.as_str(), c.moment.seq))
        .collect();
    assert_eq!(names, vec![("before prof meeting", 1), ("zeta", 2)]);
    assert_eq!(ws.checkpoints(other).len(), 1);
}

#[test]
fn a_workspace_round_trips_through_json() {
    let (mut ws, main) = Workspace::new();
    let me = MemberId::new();
    let (a, op) = card("A");
    ws.record(main, me, 1, op).unwrap();
    let b = ws
        .fork(
            "b",
            Moment {
                branch: main,
                seq: 1,
            },
            me,
            2,
        )
        .unwrap();
    ws.record(b, me, 3, set(a, "title", text("B"))).unwrap();
    ws.checkpoint("cp", Moment { branch: b, seq: 1 }, me, 4)
        .unwrap();
    let json = serde_json::to_string(&ws).unwrap();
    let back: Workspace = serde_json::from_str(&json).unwrap();
    assert_eq!(back, ws);
    let fb = back.branch(b).unwrap();
    assert_eq!((fb.created_by(), fb.created_at()), (Some(me), Some(2)));
    assert_eq!(
        back.board_at(back.head(b).unwrap()).unwrap(),
        ws.board_at(ws.head(b).unwrap()).unwrap()
    );
}

#[test]
fn record_all_applies_every_op_in_order_as_edits() {
    let (mut ws, main) = Workspace::new();
    let me = MemberId::new();
    let (a, create) = card("A");
    let head = ws
        .record_all(
            main,
            me,
            7,
            vec![
                create,
                set(a, "title", text("A2")),
                set(a, "summary", text("s")),
            ],
        )
        .unwrap();
    assert_eq!(
        head,
        Moment {
            branch: main,
            seq: 3
        }
    );
    let changes = ws.branch(main).unwrap().changes();
    assert!(
        changes
            .iter()
            .all(|c| c.author == me && c.at == 7 && c.origin == Origin::Edit)
    );
    assert!(matches!(changes[1].op, Op::Set { ref field, .. } if field == "title"));
    assert_eq!(title_at(&ws, head, a), Some(text("A2")));
}

#[test]
fn record_all_records_nothing_when_any_op_is_rejected() {
    let (mut ws, main) = Workspace::new();
    let me = MemberId::new();
    let (a, create) = card("A");
    ws.record(main, me, 1, create.clone()).unwrap();
    let before = ws.clone();
    let (_, other) = card("B");
    let bad = ws.record_all(main, me, 2, vec![other, create]);
    assert!(matches!(
        bad,
        Err(WsError::Apply(ApplyError::AlreadyExists(id))) if id == a
    ));
    assert_eq!(ws, before);
}

#[test]
fn record_all_with_no_ops_returns_the_head_and_records_nothing() {
    let (mut ws, main) = Workspace::new();
    let me = MemberId::new();
    ws.record(main, me, 1, card("A").1).unwrap();
    let before = ws.clone();
    assert_eq!(
        ws.record_all(main, me, 2, Vec::new()).unwrap(),
        Moment {
            branch: main,
            seq: 1
        }
    );
    assert_eq!(ws, before);
    assert!(matches!(
        ws.record_all(BranchId::new(), me, 2, Vec::new()),
        Err(WsError::UnknownBranch(_))
    ));
}
