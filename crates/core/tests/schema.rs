use qoop_core::*;

#[test] fn field_classes_follow_the_spec_table() {
    for f in ["title", "summary", "status", "color"] { assert_eq!(field_class(EntityKind::Card, f), Some(FieldClass::Content)); }
    for f in ["x", "y", "w", "h"] {
        assert_eq!(field_class(EntityKind::Card, f), Some(FieldClass::Layout));
        assert_eq!(field_class(EntityKind::Frame, f), Some(FieldClass::Layout));
        assert_eq!(field_class(EntityKind::Connection, f), None);
    }
    for f in ["from", "to", "label"] { assert_eq!(field_class(EntityKind::Connection, f), Some(FieldClass::Content)); }
    assert_eq!(field_class(EntityKind::Frame, "summary"), None);
}
#[test] fn accepts_valid_values_and_null_everywhere() {
    assert!(validate_field(EntityKind::Card, "title", &Value::Text("Surface codes".into())).is_ok());
    assert!(validate_field(EntityKind::Card, "x", &Value::Float(12.5)).is_ok());
    assert!(validate_field(EntityKind::Card, "status", &Value::Text("dead_end".into())).is_ok());
    assert!(validate_field(EntityKind::Connection, "from", &Value::Ref(EntityId::new())).is_ok());
    assert!(validate_field(EntityKind::Card, "title", &Value::Null).is_ok());
}
#[test] fn rejects_bad_values() {
    assert!(matches!(validate_field(EntityKind::Card, "nope", &Value::Null), Err(SchemaError::UnknownField { .. })));
    assert!(matches!(validate_field(EntityKind::Card, "title", &Value::Float(1.0)), Err(SchemaError::WrongType { .. })));
    assert!(matches!(validate_field(EntityKind::Card, "x", &Value::Float(f64::NAN)), Err(SchemaError::NotFinite { .. })));
    assert!(matches!(validate_field(EntityKind::Card, "x", &Value::Float(f64::INFINITY)), Err(SchemaError::NotFinite { .. })));
    assert!(matches!(validate_field(EntityKind::Card, "status", &Value::Text("done".into())), Err(SchemaError::BadStatus(_))));
}
#[test] fn values_round_trip_through_json() {
    let v = Value::Ref(EntityId::new());
    assert_eq!(serde_json::from_str::<Value>(&serde_json::to_string(&v).unwrap()).unwrap(), v);
}
