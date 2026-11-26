//! Runs (contract §15): checking the `result` a Member's Runner sends, and reading a stored
//! one. The server never executes anything; it only checks the shape of what was captured,
//! that it is recorded under the name of the Member who sends it, and that it lands on a Run.
//! It checks nothing about truth.

use std::collections::BTreeMap;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use infall_core::{Board, EntityId, EntityKind, MemberId, Op, Value as FieldValue};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::error::ApiError;

/// The Block field that holds what a Run captured.
pub const RESULT_FIELD: &str = "result";
/// The Block `type` of a Run.
const RUN_TYPE: &str = "run";

/// The most characters a whole `result` value may hold.
pub const MAX_RESULT_CHARS: usize = 600_000;
/// The most characters of captured output.
pub const MAX_OUTPUT_CHARS: usize = 64_000;
/// The most figures one result may carry.
pub const MAX_FIGURES: usize = 3;
/// The most base64 characters of one figure.
pub const MAX_FIGURE_CHARS: usize = 160_000;
/// The most packages the environment may list.
pub const MAX_PACKAGES: usize = 32;
/// The most characters of a package name.
pub const MAX_ENV_NAME_CHARS: usize = 60;
/// The most characters of a version or of any other environment value.
pub const MAX_ENV_VALUE_CHARS: usize = 40;

/// What every PNG file starts with.
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// The most characters of a Run Block's `env` field (one line).
pub const MAX_BLOCK_ENV_CHARS: usize = 60;

/// Whether `s` is an environment's name, as a Run Block's `env` and a result's `env.name`
/// carry it: 1–60 characters on one line, no white space at either end, and no control or
/// invisible characters (zero-width, joiners, direction marks, soft hyphen, BOM).
pub fn is_env_name(s: &str) -> bool {
    let invisible = |c: char| {
        matches!(c,
            '\u{00AD}' | '\u{034F}' | '\u{061C}' | '\u{115F}' | '\u{1160}' | '\u{17B4}'
            | '\u{17B5}' | '\u{180B}'..='\u{180F}' | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{206F}' | '\u{3164}'
            | '\u{FE00}'..='\u{FE0F}' | '\u{FEFF}' | '\u{FFA0}' | '\u{FFF0}'..='\u{FFFB}'
            | '\u{E0000}'..='\u{E0FFF}')
    };
    !s.is_empty()
        && fits(s, MAX_BLOCK_ENV_CHARS)
        && s.trim() == s
        && !s.chars().any(|c| c.is_control() || invisible(c))
}

/// Whether `s` is a language id: `^[a-z][a-z0-9_-]{0,23}$` (api.md §15, "Languages").
pub fn is_lang(s: &str) -> bool {
    let mut chars = s.chars();
    s.len() <= 24
        && chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

const KEYS: [&str; 12] = [
    "lang",
    "v",
    "by",
    "at",
    "code_sha256",
    "exit",
    "stopped",
    "duration_ms",
    "output",
    "output_truncated",
    "figures",
    "env",
];

/// What a stored `result` says, without its figures.
#[derive(Debug, Clone, PartialEq)]
pub struct RunResult {
    /// The Member who executed the Run, as written in the result.
    pub by: String,
    /// Unix ms, when the execution ended.
    pub at: f64,
    pub code_sha256: String,
    /// `None` when the execution was stopped or killed.
    pub exit: Option<i64>,
    pub stopped: bool,
    pub output: String,
    pub output_truncated: bool,
    /// How many figures it carries.
    pub figures: usize,
}

/// Whether `s` is at most `max` characters long.
fn fits(s: &str, max: usize) -> bool {
    // Every character is at least one byte, so short strings need no counting.
    s.len() <= max || s.chars().count() <= max
}

/// Refuses keys of `map` that are not in `allowed`.
fn only_keys(map: &Map<String, Value>, allowed: &[&str], what: &str) -> Result<(), String> {
    match map.keys().find(|k| !allowed.contains(&k.as_str())) {
        Some(key) => Err(format!(
            "{what} has a key that is not part of it: \"{}\".",
            crate::tools::shown(key)
        )),
        None => Ok(()),
    }
}

fn string<'a>(map: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    map.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("The result of a Run needs `{key}` as a text."))
}

/// A number that is finite and not negative.
fn amount(map: &Map<String, Value>, key: &str) -> Result<f64, String> {
    map.get(key)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.0)
        .ok_or_else(|| {
            format!("The result of a Run needs `{key}` as a number that is not negative.")
        })
}

/// An optional flag; unset is `false`.
fn flag(map: &Map<String, Value>, key: &str) -> Result<bool, String> {
    match map.get(key) {
        None => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(format!(
            "In the result of a Run `{key}` must be true or false."
        )),
    }
}

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn check_figure(figure: &Value) -> Result<(), String> {
    let map = figure
        .as_object()
        .ok_or("A figure of a Run must be an object with `png`.")?;
    only_keys(map, &["png"], "A figure of a Run")?;
    let png = map
        .get("png")
        .and_then(Value::as_str)
        .ok_or("A figure of a Run needs `png` as base64 text.")?;
    // Base64 is ASCII, so bytes are characters; anything else fails to decode below.
    if png.len() > MAX_FIGURE_CHARS {
        return Err(format!(
            "A figure of a Run may be at most {MAX_FIGURE_CHARS} base64 characters."
        ));
    }
    let bytes = STANDARD
        .decode(png)
        .map_err(|_| "A figure of a Run is not valid base64.".to_string())?;
    if !bytes.starts_with(&PNG_SIGNATURE) {
        return Err("A figure of a Run is not a PNG image.".to_string());
    }
    Ok(())
}

fn check_env_value(map: &Map<String, Value>, key: &str) -> Result<(), String> {
    match map.get(key) {
        None => Ok(()),
        Some(Value::String(s)) if fits(s, MAX_ENV_VALUE_CHARS) => Ok(()),
        Some(_) => Err(format!(
            "In the environment of a Run `{key}` must be a text of at most {MAX_ENV_VALUE_CHARS} characters."
        )),
    }
}

fn check_env(env: &Value) -> Result<(), String> {
    let map = env
        .as_object()
        .ok_or("The environment of a Run must be an object.")?;
    only_keys(
        map,
        &["python", "packages", "os", "arch", "runtime", "name"],
        "The environment of a Run",
    )?;
    for key in ["python", "os", "arch", "runtime"] {
        check_env_value(map, key)?;
    }
    // The environment the Run asked for (its Block's `env` when it was executed).
    match map.get("name") {
        None => {}
        Some(Value::String(n)) if is_env_name(n) => {}
        Some(_) => {
            return Err(format!(
                "In the environment of a Run `name` must be 1 to {MAX_BLOCK_ENV_CHARS} characters on one line, with no space at either end."
            ));
        }
    }
    let Some(packages) = map.get("packages") else {
        return Ok(());
    };
    let packages = packages
        .as_object()
        .ok_or("The packages of a Run must be an object of names and versions.")?;
    if packages.len() > MAX_PACKAGES {
        return Err(format!("A Run may list at most {MAX_PACKAGES} packages."));
    }
    for (name, version) in packages {
        let version_fits = version
            .as_str()
            .is_some_and(|v| fits(v, MAX_ENV_VALUE_CHARS));
        if !fits(name, MAX_ENV_NAME_CHARS) || !version_fits {
            return Err(format!(
                "A package of a Run needs a name of at most {MAX_ENV_NAME_CHARS} characters and a version text of at most {MAX_ENV_VALUE_CHARS}."
            ));
        }
    }
    Ok(())
}

/// Reads a `result` value, refusing anything that is not exactly the shape of §15. The
/// sentence says what is wrong.
pub fn parse(raw: &str) -> Result<RunResult, String> {
    if !fits(raw, MAX_RESULT_CHARS) {
        return Err(format!(
            "The result of a Run may be at most {MAX_RESULT_CHARS} characters."
        ));
    }
    let value: Value = serde_json::from_str(raw)
        .map_err(|_| "The result of a Run must be a JSON object.".to_string())?;
    let map = value
        .as_object()
        .ok_or("The result of a Run must be a JSON object.")?;
    only_keys(map, &KEYS, "The result of a Run")?;

    if map.get("v").and_then(Value::as_u64) != Some(1) {
        return Err("The result of a Run needs `v` to be 1.".to_string());
    }
    let by = string(map, "by")?;
    let at = amount(map, "at")?;
    let code_sha256 = string(map, "code_sha256")?;
    if !is_sha256_hex(code_sha256) {
        return Err(
            "The result of a Run needs `code_sha256` as 64 lowercase hexadecimal characters."
                .to_string(),
        );
    }
    let exit = match map.get("exit") {
        Some(Value::Null) => None,
        Some(Value::Number(n)) if n.is_i64() || n.is_u64() => Some(
            n.as_i64()
                .ok_or("The result of a Run needs `exit` as a whole number or null.")?,
        ),
        _ => return Err("The result of a Run needs `exit` as a whole number or null.".to_string()),
    };
    let stopped = flag(map, "stopped")?;
    amount(map, "duration_ms")?;
    let output = string(map, "output")?;
    if !fits(output, MAX_OUTPUT_CHARS) {
        return Err(format!(
            "The output of a Run may be at most {MAX_OUTPUT_CHARS} characters."
        ));
    }
    let output_truncated = flag(map, "output_truncated")?;
    let figures = map
        .get("figures")
        .and_then(Value::as_array)
        .ok_or("The result of a Run needs `figures` as a list.")?;
    if figures.len() > MAX_FIGURES {
        return Err(format!("A Run may have at most {MAX_FIGURES} figures."));
    }
    for figure in figures {
        check_figure(figure)?;
    }
    if let Some(env) = map.get("env") {
        check_env(env)?;
    }
    match map.get("lang") {
        None => {}
        Some(Value::String(l)) if is_lang(l) => {}
        Some(_) => {
            return Err(
                "In the result of a Run `lang` must be a language id such as \"julia\"."
                    .to_string(),
            );
        }
    }
    Ok(RunResult {
        by: by.to_string(),
        at,
        code_sha256: code_sha256.to_string(),
        exit,
        stopped,
        output: output.to_string(),
        output_truncated,
        figures: figures.len(),
    })
}

/// Lowercase hex SHA-256 of the UTF-8 bytes of `code`: what `code_sha256` is compared with.
pub fn code_sha256(code: &str) -> String {
    Sha256::digest(code.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Every `(entity, value)` that `op` writes into a `result` field.
fn result_of(op: &Op) -> Option<(EntityId, &FieldValue)> {
    match op {
        Op::Create { entity, fields, .. } => fields.get(RESULT_FIELD).map(|v| (*entity, v)),
        Op::Set {
            entity,
            field,
            value,
        } if field == RESULT_FIELD => Some((*entity, value)),
        _ => None,
    }
}

/// Checks every `result` text that `ops` carry: the shape of §15, and `by` naming `actor`.
/// Null clears a result and is always allowed; a value of another type is left for the core
/// to refuse. Says whether any result text is carried, so that the caller knows to run
/// `check_set_on_runs` under the write lock.
pub fn check_results(ops: &[Op], actor: MemberId) -> Result<bool, ApiError> {
    check_block_fields(ops)?;
    let mut any = false;
    for (_, value) in ops.iter().filter_map(result_of) {
        let FieldValue::Text(raw) = value else {
            continue;
        };
        any = true;
        let result = parse(raw).map_err(ApiError::BadRequest)?;
        if result.by != actor.0.to_string() {
            return Err(ApiError::BadRequest(
                "The result of a Run must name the Member who sends it in `by`.".to_string(),
            ));
        }
    }
    Ok(any)
}

/// Every `(field, value)` that `op` writes into `lang` or `env` (Run Blocks, M19b).
fn lang_or_env(op: &Op) -> Vec<(&str, &FieldValue)> {
    match op {
        Op::Create {
            kind: EntityKind::Block,
            fields,
            ..
        } => ["lang", "env"]
            .into_iter()
            .filter_map(|f| fields.get(f).map(|v| (f, v)))
            .collect(),
        Op::Set { field, value, .. } if field == "lang" || field == "env" => {
            vec![(field.as_str(), value)]
        }
        _ => Vec::new(),
    }
}

/// The shape of a Run Block's `lang` (a language id) and `env` (1–60 characters, one line).
/// Null clears either; another type is left for the core to refuse.
fn check_block_fields(ops: &[Op]) -> Result<(), ApiError> {
    for (field, value) in ops.iter().flat_map(lang_or_env) {
        let FieldValue::Text(t) = value else {
            continue;
        };
        let ok = match field {
            "lang" => is_lang(t),
            _ => is_env_name(t),
        };
        if !ok {
            return Err(ApiError::BadRequest(if field == "lang" {
                "The `lang` of a Run must be a language id such as \"julia\".".to_string()
            } else {
                format!(
                    "The `env` of a Run must be 1 to {MAX_BLOCK_ENV_CHARS} characters on one line, with no space at either end."
                )
            }));
        }
    }
    Ok(())
}

/// Checks that every Block that `ops` give a result text is a Run: its `type` is `run` when
/// the result is written (on `board`, or by an earlier op of the same batch, or in the same
/// Create), or has become `run` by the end of the batch. Entities that are not Blocks, or
/// that do not exist, are left for the core to refuse.
pub fn check_set_on_runs(ops: &[Op], board: &Board) -> Result<(), ApiError> {
    // Per Block touched here: whether its `type` is `run` as the ops apply in order.
    let mut is_run: BTreeMap<EntityId, bool> = BTreeMap::new();
    // Blocks given a result while they were not a Run; fine if they become one.
    let mut owed: Vec<EntityId> = Vec::new();
    let on_board = |id: EntityId| {
        board
            .get(id)
            .filter(|e| e.kind == EntityKind::Block)
            .map(|e| matches!(e.get("type"), FieldValue::Text(t) if t == RUN_TYPE))
    };
    for op in ops {
        match op {
            Op::Create {
                entity,
                kind: EntityKind::Block,
                fields,
            } => {
                let run = matches!(fields.get("type"), Some(FieldValue::Text(t)) if t == RUN_TYPE);
                is_run.insert(*entity, run);
            }
            Op::Set {
                entity,
                field,
                value,
            } if field == "type"
                && (is_run.contains_key(entity) || on_board(*entity).is_some()) =>
            {
                let run = matches!(value, FieldValue::Text(t) if t == RUN_TYPE);
                is_run.insert(*entity, run);
            }
            _ => {}
        }
        // Not a Run at this point: owed. A Run already, or nothing the core will accept a
        // result on, needs nothing.
        if let Some((entity, FieldValue::Text(_))) = result_of(op)
            && is_run.get(&entity).copied().or_else(|| on_board(entity)) == Some(false)
        {
            owed.push(entity);
        }
    }
    if owed
        .iter()
        .all(|entity| is_run.get(entity).copied().unwrap_or(false))
    {
        Ok(())
    } else {
        Err(ApiError::BadRequest(
            "A result can be recorded only on a Run.".to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid() -> Value {
        json!({
            "v": 1, "by": "m", "at": 1_790_000_000_000_i64, "code_sha256": "0".repeat(64),
            "exit": 0, "duration_ms": 12, "output": "ok", "figures": []
        })
    }

    #[test]
    fn the_smallest_result_is_read() {
        let r = parse(&valid().to_string()).unwrap();
        assert_eq!(r.by, "m");
        assert_eq!(r.exit, Some(0));
        assert!(!r.stopped && !r.output_truncated);
        assert_eq!(r.figures, 0);
    }

    #[test]
    fn a_whole_number_is_wanted_for_v_and_exit() {
        for (key, bad) in [
            ("v", json!(1.0)),
            ("v", json!(2)),
            ("v", json!("1")),
            ("exit", json!(0.5)),
            ("exit", json!("0")),
            ("exit", json!(1e30)),
        ] {
            let mut r = valid();
            r[key] = bad.clone();
            assert!(parse(&r.to_string()).is_err(), "{key} = {bad}");
        }
        let mut r = valid();
        r["exit"] = json!(-9);
        assert_eq!(parse(&r.to_string()).unwrap().exit, Some(-9));
    }

    #[test]
    fn a_result_may_say_its_language_and_runtime() {
        let mut r = valid();
        r["lang"] = json!("julia");
        r["env"] = json!({ "runtime": "julia version 1.11.2" });
        assert!(parse(&r.to_string()).is_ok());
        for bad in [json!("Julia"), json!(""), json!("j".repeat(25)), json!(1)] {
            r["lang"] = bad.clone();
            assert!(parse(&r.to_string()).is_err(), "{bad}");
        }
        r["lang"] = json!("qsharp");
        r["env"] = json!({ "runtime": "r".repeat(41) });
        assert!(parse(&r.to_string()).is_err());
        assert!(is_lang("a_b-9") && !is_lang("9a") && !is_lang("a b"));
    }

    #[test]
    fn a_result_may_name_the_environment_it_asked_for() {
        let mut r = valid();
        for good in ["analysis", "py 3.12 (conda)", &"é".repeat(60)] {
            r["env"] =
                json!({ "name": good, "python": "3.12.3", "packages": { "numpy": "2.1.0" } });
            assert!(parse(&r.to_string()).is_ok(), "{good}");
        }
        for bad in [
            json!(""),
            json!(" analysis"),
            json!("analysis "),
            json!("a\nb"),
            json!("a\tb"),
            json!("zero\u{200B}width"),
            json!("bom\u{FEFF}"),
            json!("e".repeat(61)),
            json!(5),
            json!(null),
        ] {
            r["env"] = json!({ "name": bad.clone() });
            assert!(parse(&r.to_string()).is_err(), "{bad}");
        }
        assert!(!is_env_name("rtl\u{202E}x") && is_env_name("a b"));
    }

    #[test]
    fn a_run_blocks_lang_and_env_are_checked() {
        use infall_core::{Fields, Op, Value as V};
        let set = |field: &str, v: V| Op::Set {
            entity: EntityId::new(),
            field: field.to_string(),
            value: v,
        };
        assert!(check_block_fields(&[set("lang", V::Text("julia".into()))]).is_ok());
        assert!(check_block_fields(&[set("lang", V::Null)]).is_ok());
        assert!(check_block_fields(&[set("env", V::Text("py312".into()))]).is_ok());
        assert!(check_block_fields(&[set("lang", V::Text("Julia".into()))]).is_err());
        assert!(check_block_fields(&[set("env", V::Text(String::new()))]).is_err());
        assert!(check_block_fields(&[set("env", V::Text("a\nb".into()))]).is_err());
        assert!(check_block_fields(&[set("env", V::Text("e".repeat(61)))]).is_err());
        let mut fields = Fields::new();
        fields.insert("lang".into(), V::Text("NOPE".into()));
        let create = Op::Create {
            entity: EntityId::new(),
            kind: EntityKind::Block,
            fields,
        };
        assert!(check_block_fields(&[create]).is_err());
    }

    #[test]
    fn the_hash_of_code_is_lowercase_hex_of_its_bytes() {
        assert_eq!(
            code_sha256("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
