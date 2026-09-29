mod common;
use common::*;
use qoop_core::*;

#[test]
fn create_then_set_changes_one_field() {
    let mut b = Board::new();
    let (id, op) = card("Grover search");
    b.apply(&op).unwrap();
    b.apply(&set(id, "x", Value::Float(40.0))).unwrap();
    let e = b.get(id).unwrap();
    assert_eq!(e.get("title"), &text("Grover search"));
    assert_eq!(e.get("x"), &Value::Float(40.0));
    assert_eq!(e.get("summary"), &Value::Null);
}

#[test]
fn rejected_operations_leave_the_board_unchanged() {
    let mut b = Board::new();
    let (id, op) = card("A");
    b.apply(&op).unwrap();
    let before = b.clone();
    assert_eq!(b.apply(&op), Err(ApplyError::AlreadyExists(id)));
    assert!(matches!(
        b.apply(&set(id, "nope", Value::Null)),
        Err(ApplyError::Schema(_))
    ));
    let ghost = EntityId::new();
    assert_eq!(
        b.apply(&set(ghost, "title", text("x"))),
        Err(ApplyError::UnknownEntity(ghost))
    );
    assert_eq!(
        b.apply(&Op::Undelete { entity: id }),
        Err(ApplyError::NotDeleted(id))
    );
    assert_eq!(b, before);
}

#[test]
fn delete_keeps_a_tombstone_that_can_come_back() {
    let mut b = Board::new();
    let (id, op) = card("A");
    b.apply(&op).unwrap();
    b.apply(&Op::Delete { entity: id }).unwrap();
    assert!(b.get(id).unwrap().deleted);
    assert!(!b.is_visible(id));
    assert_eq!(
        b.apply(&set(id, "title", text("B"))),
        Err(ApplyError::Deleted(id))
    );
    assert_eq!(
        b.apply(&Op::Delete { entity: id }),
        Err(ApplyError::Deleted(id))
    );
    b.apply(&Op::Undelete { entity: id }).unwrap();
    assert_eq!(b.get(id).unwrap().get("title"), &text("A"));
}

#[test]
fn connection_endpoints_are_checked() {
    let mut b = Board::new();
    let (a, op) = card("A");
    b.apply(&op).unwrap();
    let ghost = EntityId::new();
    let (_, bad) = connect(a, ghost);
    assert_eq!(b.apply(&bad), Err(ApplyError::BadEndpoint(ghost)));
    let c = EntityId::new();
    assert_eq!(
        b.apply(&Op::Create {
            entity: c,
            kind: EntityKind::Connection,
            fields: Fields::new()
        }),
        Err(ApplyError::MissingEndpoint(c))
    );
}

#[test]
fn connection_hides_while_an_endpoint_is_deleted() {
    let mut b = Board::new();
    let (a, o1) = card("A");
    let (z, o2) = card("Z");
    b.apply(&o1).unwrap();
    b.apply(&o2).unwrap();
    let (c, o3) = connect(a, z);
    b.apply(&o3).unwrap();
    assert!(b.is_visible(c));
    b.apply(&Op::Delete { entity: z }).unwrap();
    assert!(!b.is_visible(c));
    assert!(!b.get(c).unwrap().deleted);
    b.apply(&Op::Undelete { entity: z }).unwrap();
    assert!(b.is_visible(c));
}

#[test]
fn same_content_ignores_tombstones_and_null() {
    let (id, op) = card("A");
    let mut a = Board::new();
    a.apply(&op).unwrap();
    let mut b = a.clone();
    let (gone, op2) = card("gone");
    b.apply(&op2).unwrap();
    b.apply(&Op::Delete { entity: gone }).unwrap();
    b.apply(&set(id, "summary", Value::Null)).unwrap();
    assert!(a.same_content(&b));
    b.apply(&set(id, "summary", text("s"))).unwrap();
    assert!(!a.same_content(&b));
}

#[test]
fn null_is_never_stored_and_endpoint_edits_are_checked() {
    let mut b = Board::new();
    let (a, o1) = card("A");
    let (z, o2) = card("Z");
    b.apply(&o1).unwrap();
    b.apply(&o2).unwrap();
    let id = EntityId::new();
    let mut fields = Fields::new();
    fields.insert("title".to_string(), Value::Null);
    b.apply(&Op::Create {
        entity: id,
        kind: EntityKind::Frame,
        fields,
    })
    .unwrap();
    assert!(b.get(id).unwrap().fields.is_empty());
    let (c, o3) = connect(a, z);
    b.apply(&o3).unwrap();
    let before = b.clone();
    assert_eq!(
        b.apply(&set(c, "to", Value::Null)),
        Err(ApplyError::MissingEndpoint(c))
    );
    assert_eq!(
        b.apply(&set(c, "to", Value::Ref(c))),
        Err(ApplyError::BadEndpoint(c))
    );
    assert_eq!(b, before);
}
