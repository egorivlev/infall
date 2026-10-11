mod common;
use common::*;
use qoop_core::*;

fn op_create(kind: EntityKind, fields: &[(&str, Value)]) -> (EntityId, Op) {
    let id = EntityId::new();
    let fields: Fields = fields
        .iter()
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect();
    (
        id,
        Op::Create {
            entity: id,
            kind,
            fields,
        },
    )
}

fn block(card_id: EntityId, body: &str, order: &str) -> (EntityId, Op) {
    op_create(
        EntityKind::Block,
        &[
            ("card", Value::Ref(card_id)),
            ("type", text("text")),
            ("text", text(body)),
            ("order", text(order)),
        ],
    )
}

#[test]
fn a_block_needs_an_existing_card_and_a_known_type() {
    let mut board = Board::new();
    let (a, create_a) = card("A");
    board.apply(&create_a).unwrap();
    let (frame, create_frame) = op_create(EntityKind::Frame, &[("title", text("F"))]);
    board.apply(&create_frame).unwrap();

    let (b, create_b) = block(a, "hello", "a0");
    board.apply(&create_b).unwrap();
    assert!(board.is_visible(b));

    let (orphan, create_orphan) = op_create(EntityKind::Block, &[("text", text("x"))]);
    assert_eq!(
        board.apply(&create_orphan),
        Err(ApplyError::MissingEndpoint(orphan))
    );
    let (_, on_frame) = block(frame, "x", "a0");
    assert_eq!(board.apply(&on_frame), Err(ApplyError::BadEndpoint(frame)));
    let (_, bad_type) = op_create(
        EntityKind::Block,
        &[("card", Value::Ref(a)), ("type", text("video"))],
    );
    assert!(matches!(
        board.apply(&bad_type),
        Err(ApplyError::Schema(SchemaError::BadBlockType(_)))
    ));
    assert_eq!(
        board.apply(&set(b, "card", Value::Null)),
        Err(ApplyError::MissingEndpoint(b))
    );
    assert!(matches!(
        board.apply(&set(b, "x", Value::Float(1.0))),
        Err(ApplyError::Schema(SchemaError::UnknownField { .. }))
    ));
}

#[test]
fn blocks_and_attachments_hide_with_what_they_refer_to() {
    let mut board = Board::new();
    let (a, create_a) = card("A");
    board.apply(&create_a).unwrap();
    let (src, create_src) = op_create(
        EntityKind::Source,
        &[
            ("url", text("https://arxiv.org/abs/2103.05577")),
            ("title", text("Jerbi")),
        ],
    );
    board.apply(&create_src).unwrap();
    let (b, create_b) = block(a, "hello", "a0");
    board.apply(&create_b).unwrap();
    let (att, create_att) = op_create(
        EntityKind::Attachment,
        &[("card", Value::Ref(a)), ("source", Value::Ref(src))],
    );
    board.apply(&create_att).unwrap();
    assert!(board.is_visible(att));

    // An Attachment must point at a Source, not a Card.
    let (_, wrong) = op_create(
        EntityKind::Attachment,
        &[("card", Value::Ref(a)), ("source", Value::Ref(a))],
    );
    assert_eq!(board.apply(&wrong), Err(ApplyError::BadEndpoint(a)));

    board.apply(&Op::Delete { entity: src }).unwrap();
    assert!(!board.is_visible(att));
    assert!(board.is_visible(b));
    board.apply(&Op::Undelete { entity: src }).unwrap();
    board.apply(&Op::Delete { entity: a }).unwrap();
    assert!(!board.is_visible(att));
    assert!(!board.is_visible(b));
    assert!(!board.get(b).unwrap().deleted);
}

#[test]
fn a_page_merges_block_by_block() {
    // main: Card A with blocks p1, p2. Branch edits p1 and adds p3 with a Source;
    // main edits p2 and reorders p1. Then both edit p2: a Conflict.
    let (mut ws, main) = Workspace::new();
    let me = MemberId::new();
    let (a, create_a) = card("A");
    let (p1, create_p1) = block(a, "one", "a0");
    let (p2, create_p2) = block(a, "two", "a1");
    for op in [create_a, create_p1, create_p2] {
        ws.record(main, me, 1, op).unwrap();
    }
    let side = ws.fork("side", ws.head(main).unwrap(), me, 2).unwrap();

    ws.record(side, me, 3, set(p1, "text", text("one, revised")))
        .unwrap();
    ws.record(side, me, 3, set(p1, "order", text("a5")))
        .unwrap();
    let (p3, create_p3) = block(a, "three", "a2");
    let (src, create_src) = op_create(EntityKind::Source, &[("doi", text("10.1/x"))]);
    let (att, create_att) = op_create(
        EntityKind::Attachment,
        &[("card", Value::Ref(a)), ("source", Value::Ref(src))],
    );
    // Recorded with the Attachment before nothing it needs is missing on side.
    for op in [create_p3, create_src, create_att] {
        ws.record(side, me, 3, op).unwrap();
    }
    ws.record(side, me, 3, set(p2, "text", text("two (side)")))
        .unwrap();
    ws.record(main, me, 4, set(p2, "text", text("two (main)")))
        .unwrap();
    ws.record(main, me, 4, set(p1, "order", text("a9")))
        .unwrap();

    let plan = ws.plan_merge(side, main).unwrap();
    assert_eq!(
        plan.conflicts.iter().map(Conflict::key).collect::<Vec<_>>(),
        vec![ConflictKey {
            entity: p2,
            field: Some("text".to_string())
        }]
    );
    // The Source is created before the Attachment that refers to it.
    let position = |id: EntityId| {
        plan.auto
            .iter()
            .position(|op| matches!(op, Op::Create { entity, .. } if *entity == id))
            .unwrap()
    };
    assert!(position(src) < position(att));
    assert!(plan.auto.contains(&set(p1, "text", text("one, revised"))));
    // Order changed on both: main's wins, silently.
    assert!(!plan.auto.iter().any(
        |op| matches!(op, Op::Set { entity, field, .. } if *entity == p1 && field == "order")
    ));

    let decisions = decide_all(&plan, Decision::TakeSource);
    ws.apply_merge(&plan, &decisions, me, 5, None).unwrap();
    let board = head_board(&ws, main);
    assert_eq!(board.get(p2).unwrap().get("text"), &text("two (side)"));
    assert_eq!(board.get(p1).unwrap().get("order"), &text("a9"));
    assert!(board.is_visible(p3) && board.is_visible(att));

    // Restore to before the Merge and back keeps every reference valid.
    ws.restore(main, plan.target.seq, me, 6).unwrap();
    assert!(!head_board(&ws, main).is_visible(att));
    let json = serde_json::to_string(&ws).unwrap();
    assert_eq!(serde_json::from_str::<Workspace>(&json).unwrap(), ws);
}

fn head_board(ws: &Workspace, branch: BranchId) -> Board {
    ws.board_at(ws.head(branch).unwrap()).unwrap()
}

fn decide_all(plan: &MergePlan, decision: Decision) -> Decisions {
    plan.conflicts
        .iter()
        .map(|c| (c.key(), decision.clone()))
        .collect()
}

#[test]
fn a_visual_is_a_block_with_source_and_a_title() {
    let mut board = Board::new();
    let (a, create_a) = card("A");
    board.apply(&create_a).unwrap();
    let (v, create_v) = op_create(
        EntityKind::Block,
        &[
            ("card", Value::Ref(a)),
            ("type", text("visual")),
            ("title", text("Bloch sphere")),
            ("text", text("<canvas></canvas><script>1</script>")),
            ("order", text("a0")),
        ],
    );
    board.apply(&create_v).unwrap();
    assert!(board.is_visible(v));
    assert_eq!(
        field_class(EntityKind::Block, "title"),
        Some(FieldClass::Content)
    );
    // A caption is only for Blocks.
    assert!(matches!(
        board.apply(&set(a, "type", text("visual"))),
        Err(ApplyError::Schema(SchemaError::UnknownField { .. }))
    ));
}

#[test]
fn a_pinned_block_carries_who_pinned_it_and_whether_it_was_reviewed() {
    let mut board = Board::new();
    let (a, create_a) = card("A");
    board.apply(&create_a).unwrap();
    let (b, create_b) = op_create(
        EntityKind::Block,
        &[
            ("card", Value::Ref(a)),
            ("text", text("The plateau looks like limited expressivity.")),
            ("order", text("a0")),
            ("ai_model", text("claude-sonnet")),
            ("ai_pinned_by", text("member-1")),
            ("ai_pinned_at", Value::Float(1_700_000_000_000.0)),
        ],
    );
    board.apply(&create_b).unwrap();
    assert_eq!(board.get(b).unwrap().get("ai_reviewed_by"), &Value::Null);
    board
        .apply(&set(b, "ai_reviewed_by", text("member-2")))
        .unwrap();
    assert!(matches!(
        board.apply(&set(b, "ai_pinned_at", text("yesterday"))),
        Err(ApplyError::Schema(SchemaError::WrongType { .. }))
    ));
    // Only Blocks carry these.
    assert!(matches!(
        board.apply(&set(a, "ai_model", text("x"))),
        Err(ApplyError::Schema(SchemaError::UnknownField { .. }))
    ));
}
