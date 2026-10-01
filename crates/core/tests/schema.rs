use qoop_core::*;

#[test]
fn field_classes_follow_the_spec_table() {
    for f in ["title", "summary", "status"] {
        assert_eq!(field_class(EntityKind::Card, f), Some(FieldClass::Content));
    }
    for f in ["x", "y", "w", "h"] {
        assert_eq!(field_class(EntityKind::Card, f), Some(FieldClass::Layout));
        assert_eq!(field_class(EntityKind::Frame, f), Some(FieldClass::Layout));
        assert_eq!(field_class(EntityKind::Connection, f), None);
    }
    for f in ["from", "to", "label"] {
        assert_eq!(
            field_class(EntityKind::Connection, f),
            Some(FieldClass::Content)
        );
    }
    assert_eq!(field_class(EntityKind::Frame, "summary"), None);
}
#[test]
fn accepts_valid_values_and_null_everywhere() {
    assert!(
        validate_field(
            EntityKind::Card,
            "title",
            &Value::Text("Surface codes".into())
        )
        .is_ok()
    );
    assert!(validate_field(EntityKind::Card, "x", &Value::Float(12.5)).is_ok());
    assert!(validate_field(EntityKind::Card, "status", &Value::Text("dead_end".into())).is_ok());
    assert!(validate_field(EntityKind::Connection, "from", &Value::Ref(EntityId::new())).is_ok());
    assert!(validate_field(EntityKind::Card, "title", &Value::Null).is_ok());
}
#[test]
fn rejects_bad_values() {
    assert!(matches!(
        validate_field(EntityKind::Card, "nope", &Value::Null),
        Err(SchemaError::UnknownField { .. })
    ));
    assert!(matches!(
        validate_field(EntityKind::Card, "title", &Value::Float(1.0)),
        Err(SchemaError::WrongType { .. })
    ));
    assert!(matches!(
        validate_field(EntityKind::Card, "x", &Value::Float(f64::NAN)),
        Err(SchemaError::NotFinite { .. })
    ));
    assert!(matches!(
        validate_field(EntityKind::Card, "x", &Value::Float(f64::INFINITY)),
        Err(SchemaError::NotFinite { .. })
    ));
    assert!(matches!(
        validate_field(EntityKind::Card, "status", &Value::Text("done".into())),
        Err(SchemaError::BadStatus(_))
    ));
}
#[test]
fn values_round_trip_through_json() {
    let v = Value::Ref(EntityId::new());
    assert_eq!(
        serde_json::from_str::<Value>(&serde_json::to_string(&v).unwrap()).unwrap(),
        v
    );
}

#[test]
fn color_is_no_longer_a_card_field() {
    assert_eq!(field_class(EntityKind::Card, "color"), None);
    assert!(matches!(
        validate_field(EntityKind::Card, "color", &Value::Text("blue".into())),
        Err(SchemaError::UnknownField { .. })
    ));
}

#[test]
fn connection_kind_is_a_content_field() {
    assert_eq!(
        field_class(EntityKind::Connection, "kind"),
        Some(FieldClass::Content)
    );
    assert_eq!(field_class(EntityKind::Card, "kind"), None);
    assert_eq!(field_class(EntityKind::Frame, "kind"), None);
    for k in ["related", "directed", "contradicts"] {
        assert!(validate_field(EntityKind::Connection, "kind", &Value::Text(k.into())).is_ok());
    }
    assert!(validate_field(EntityKind::Connection, "kind", &Value::Null).is_ok());
    assert!(matches!(
        validate_field(EntityKind::Connection, "kind", &Value::Text("causes".into())),
        Err(SchemaError::BadKind(k)) if k == "causes"
    ));
    for kind in [EntityKind::Card, EntityKind::Frame] {
        assert!(matches!(
            validate_field(kind, "kind", &Value::Text("related".into())),
            Err(SchemaError::UnknownField { .. })
        ));
    }
}
