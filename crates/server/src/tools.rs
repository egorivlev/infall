//! What the tools of the tool endpoint read (contract §12): pure functions from a `Board`
//! (or the `Workspace`) to the JSON a model is given. Nothing here can change anything.
//!
//! An `Err` is a plain sentence for the model, so it can correct its call.

use std::collections::{BTreeMap, BTreeSet};

use qoop_core::{Board, Entity, EntityId, EntityKind, MemberId, Value as FieldValue, Workspace};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::runs;
use crate::store::{SuggestionKind, SuggestionRecord};

/// The most Cards `list_cards` returns.
pub const MAX_CARDS: usize = 200;
/// The most Connections `list_connections` returns.
pub const MAX_CONNECTIONS: usize = 500;
/// The most Sources `list_sources` returns.
pub const MAX_SOURCES: usize = 500;
/// The most characters of a Page `get_card` returns before cutting it with "…".
pub const MAX_PAGE_CHARS: usize = 20_000;
/// The most characters of a Run's captured output `get_card` returns: its end.
pub const MAX_RUN_OUTPUT_CHARS: usize = 4_000;

/// The size the UI draws a Card at when `w`/`h` are unset.
const CARD_SIZE: (f64, f64) = (224.0, 132.0);
/// The size the UI gives a Frame when `w`/`h` are unset.
const FRAME_SIZE: (f64, f64) = (520.0, 360.0);

/// What a tool gives back: JSON for the model, or a sentence saying what to correct.
pub type ToolResult = Result<Value, String>;

fn text<'a>(e: &'a Entity, field: &str) -> &'a str {
    match e.get(field) {
        FieldValue::Text(s) => s,
        _ => "",
    }
}

fn number(e: &Entity, field: &str, default: f64) -> f64 {
    match e.get(field) {
        FieldValue::Float(f) => *f,
        _ => default,
    }
}

fn reference(e: &Entity, field: &str) -> Option<EntityId> {
    match e.get(field) {
        FieldValue::Ref(id) => Some(*id),
        _ => None,
    }
}

fn live(board: &Board, kind: EntityKind) -> impl Iterator<Item = (EntityId, &Entity)> {
    board
        .entities()
        .filter(move |(_, e)| e.kind == kind && !e.deleted)
}

/// Visible entities of `kind`: live, and everything they refer to is live.
fn visible(board: &Board, kind: EntityKind) -> impl Iterator<Item = (EntityId, &Entity)> {
    live(board, kind).filter(|(id, _)| board.is_visible(*id))
}

/// The Card with that id if it is live at this Board.
pub fn live_card(board: &Board, raw: &str) -> Result<EntityId, String> {
    let id = Uuid::parse_str(raw.trim()).ok().map(EntityId);
    match id.and_then(|id| board.get(id).map(|e| (id, e))) {
        Some((id, e)) if e.kind == EntityKind::Card && !e.deleted => Ok(id),
        _ => Err(format!(
            "There is no Card with id \"{}\" on this Branch. Use list_cards to find Card ids.",
            shown(raw)
        )),
    }
}

/// A value echoed back in a sentence: one line, not too long.
pub fn shown(raw: &str) -> String {
    raw.chars()
        .filter(|c| !c.is_control())
        .take(80)
        .collect::<String>()
}

/// The title of an entity, also when it has been deleted; empty if it has none.
fn title_of(board: &Board, id: EntityId) -> &str {
    board.get(id).map_or("", |e| text(e, "title"))
}

fn card_ref(board: &Board, id: EntityId) -> Value {
    json!({ "id": id, "title": title_of(board, id) })
}

fn status_of(card: &Entity) -> &str {
    match text(card, "status") {
        "" => "idea",
        s => s,
    }
}

fn kind_of(connection: &Entity) -> &str {
    match text(connection, "kind") {
        "" => "related",
        k => k,
    }
}

/// Sets `key` when `value` is not empty.
fn put(map: &mut Map<String, Value>, key: &str, value: &str) {
    if !value.is_empty() {
        map.insert(key.to_string(), Value::String(value.to_string()));
    }
}

// ---------------------------------------------------------------- Frames

struct FrameBox<'a> {
    title: &'a str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl FrameBox<'_> {
    fn contains(&self, (px, py): (f64, f64)) -> bool {
        px >= self.x && px <= self.x + self.w && py >= self.y && py <= self.y + self.h
    }
}

/// Live Frames in id order.
fn frames(board: &Board) -> Vec<FrameBox<'_>> {
    live(board, EntityKind::Frame)
        .map(|(_, f)| FrameBox {
            title: text(f, "title"),
            x: number(f, "x", 0.0),
            y: number(f, "y", 0.0),
            w: number(f, "w", FRAME_SIZE.0),
            h: number(f, "h", FRAME_SIZE.1),
        })
        .collect()
}

fn centre(card: &Entity) -> (f64, f64) {
    (
        number(card, "x", 0.0) + number(card, "w", CARD_SIZE.0) / 2.0,
        number(card, "y", 0.0) + number(card, "h", CARD_SIZE.1) / 2.0,
    )
}

/// The first Frame whose rectangle holds the Card's centre (membership is geometric).
fn frame_of<'a>(frames: &'a [FrameBox<'a>], card: &Entity) -> Option<&'a str> {
    let c = centre(card);
    frames.iter().find(|f| f.contains(c)).map(|f| f.title)
}

fn same_title(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

// ---------------------------------------------------------------- counts

/// Per Card, how many visible entities of `kind` point at it through `card`.
fn per_card(board: &Board, kind: EntityKind) -> BTreeMap<EntityId, usize> {
    let mut counts = BTreeMap::new();
    for (_, e) in visible(board, kind) {
        if let Some(card) = reference(e, "card") {
            *counts.entry(card).or_insert(0) += 1;
        }
    }
    counts
}

// ---------------------------------------------------------------- the tools

/// `list_branches`: `main` first, then by name.
pub fn list_branches(ws: &Workspace) -> Value {
    let mut branches: Vec<_> = ws.branches().collect();
    branches.sort_by_key(|b| (b.name() != "main", b.name().to_string()));
    let list: Vec<Value> = branches
        .iter()
        .map(|b| {
            let mut m = Map::new();
            m.insert("name".into(), json!(b.name()));
            if let Some(parent) = b.parent().and_then(|p| ws.branch(p.branch)) {
                m.insert("parent".into(), json!(parent.name()));
            }
            m.insert("changes".into(), json!(b.changes().len()));
            Value::Object(m)
        })
        .collect();
    Value::Array(list)
}

/// `list_cards`: live Cards ordered by title, optionally only those whose title or summary
/// contains `query` (ignoring case) and those inside a Frame titled `frame`.
pub fn list_cards(board: &Board, query: Option<&str>, frame: Option<&str>) -> ToolResult {
    let frames = frames(board);
    let query = query
        .map(|q| q.trim().to_lowercase())
        .filter(|q| !q.is_empty());
    let frame = frame.map(str::trim).filter(|f| !f.is_empty());
    if let Some(wanted) = frame
        && !frames.iter().any(|f| same_title(f.title, wanted))
    {
        return Err(format!(
            "There is no Frame titled \"{}\" on this Branch.",
            shown(wanted)
        ));
    }
    let blocks = per_card(board, EntityKind::Block);
    let sources = per_card(board, EntityKind::Attachment);

    let mut found: Vec<(EntityId, &Entity, Option<&str>)> = Vec::new();
    for (id, card) in live(board, EntityKind::Card) {
        let inside = match frame {
            Some(wanted) => {
                let c = centre(card);
                match frames
                    .iter()
                    .find(|f| same_title(f.title, wanted) && f.contains(c))
                {
                    Some(f) => Some(f.title),
                    None => continue,
                }
            }
            None => frame_of(&frames, card),
        };
        if let Some(q) = &query
            && !text(card, "title").to_lowercase().contains(q)
            && !text(card, "summary").to_lowercase().contains(q)
        {
            continue;
        }
        found.push((id, card, inside));
    }
    found.sort_by_key(|(id, card, _)| (text(card, "title").to_lowercase(), *id));
    let truncated = found.len() > MAX_CARDS;
    let cards: Vec<Value> = found
        .into_iter()
        .take(MAX_CARDS)
        .map(|(id, card, inside)| {
            let mut m = Map::new();
            m.insert("id".into(), json!(id));
            m.insert("title".into(), json!(text(card, "title")));
            m.insert("status".into(), json!(status_of(card)));
            m.insert("summary".into(), json!(text(card, "summary")));
            if let Some(f) = inside {
                m.insert("frame".into(), json!(f));
            }
            m.insert(
                "blocks".into(),
                json!(blocks.get(&id).copied().unwrap_or(0)),
            );
            m.insert(
                "sources".into(),
                json!(sources.get(&id).copied().unwrap_or(0)),
            );
            Value::Object(m)
        })
        .collect();
    Ok(json!({ "cards": cards, "truncated": truncated }))
}

/// A Member named in a sentence; someone no longer on the team has no name to give.
fn member_name<'a>(names: &'a BTreeMap<MemberId, String>, by: &str) -> &'a str {
    Uuid::parse_str(by)
        .ok()
        .and_then(|id| names.get(&MemberId(id)))
        .map_or("someone no longer on the team", String::as_str)
}

/// Unix ms as `2026-11-22 14:03 UTC`.
fn when(at_ms: f64) -> String {
    // Saturating: a result may carry any non-negative number.
    let secs = (at_ms / 1000.0).floor().min(253_402_300_799.0) as i64;
    let (days, of_day) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Days since 1970-01-01 to a date of the Gregorian calendar (Hinnant's civil_from_days).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02} UTC",
        of_day / 3_600,
        of_day % 3_600 / 60
    )
}

/// `body` as a fenced code block; the fence is longer than any run of backticks inside, so
/// the content cannot close it.
fn fenced(language: &str, body: &str) -> String {
    let mut longest = 0;
    let mut run = 0;
    for c in body.chars() {
        run = if c == '`' { run + 1 } else { 0 };
        longest = longest.max(run);
    }
    let fence = "`".repeat((longest + 1).max(3));
    let end = if body.ends_with('\n') { "" } else { "\n" };
    format!("{fence}{language}\n{body}{end}{fence}")
}

/// A caption or name in a heading line: one line, in quotes; empty when there is none.
fn quoted(title: &str) -> String {
    let title: String = title
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    match title.trim() {
        "" => String::new(),
        t => format!(" \"{t}\""),
    }
}

/// The last `max` characters of `s`.
fn tail(s: &str, max: usize) -> &str {
    match s.char_indices().rev().nth(max.saturating_sub(1)) {
        Some((start, _)) if max > 0 => &s[start..],
        _ => s,
    }
}

/// What a model is told about the last execution of a Run: who, when, how it ended, whether
/// the code changed since, how many figures, and the end of the output. Never the figures
/// themselves and never the stored JSON.
fn run_result(block: &Entity, names: &BTreeMap<MemberId, String>) -> String {
    let raw = text(block, runs::RESULT_FIELD);
    if raw.is_empty() {
        return "This Run has not been executed yet: it has no captured output.".to_string();
    }
    let Ok(result) = runs::parse(raw) else {
        return "This Run has a captured result that cannot be read.".to_string();
    };
    let ended = match (result.exit, result.stopped) {
        (Some(code), _) => format!("It ended with exit code {code}."),
        (None, true) => "The Member stopped it before it ended, so it has no exit code.".into(),
        (None, false) => "It was killed before it ended, so it has no exit code.".into(),
    };
    let changed = if runs::code_sha256(text(block, "text")) == result.code_sha256 {
        "The code has not changed since."
    } else {
        "The code has changed since, so this output is from an earlier version of the code."
    };
    let figures = match result.figures {
        0 => "It produced no figures.".to_string(),
        1 => "It produced 1 figure (an image, not included here).".to_string(),
        n => format!("It produced {n} figures (images, not included here)."),
    };
    let mut lines = format!(
        "Last executed by {} on {}. {ended} {changed} {figures}",
        member_name(names, &result.by),
        when(result.at),
    );
    if result.output.is_empty() {
        lines.push_str(" It printed nothing.");
        return lines;
    }
    let shown = tail(&result.output, MAX_RUN_OUTPUT_CHARS);
    let mut intro = if shown.len() < result.output.len() {
        format!("The last {MAX_RUN_OUTPUT_CHARS} characters of its captured output")
    } else {
        "Its captured output".to_string()
    };
    if result.output_truncated {
        intro.push_str(" (the middle was dropped when it was captured)");
    }
    format!("{lines} {intro}:\n\n{}", fenced("text", shown))
}

/// One Block as the Markdown a model reads: a text Block as it is; a Visual and a Run under
/// a line that says what they are, with their source in a code block; a Run also with what
/// its last execution gave. `None` for a Block with nothing to show.
fn block_markdown(block: &Entity, names: &BTreeMap<MemberId, String>) -> Option<String> {
    let body = text(block, "text");
    let title = quoted(text(block, "title"));
    match text(block, "type") {
        "run" => {
            let code = if body.trim().is_empty() {
                "It has no code yet.".to_string()
            } else {
                fenced("python", body)
            };
            Some(format!(
                "Run{title} — a Simulation: experiment code a Member executes on their own computer, kept with the output captured the last time.\n\n{code}\n\n{}",
                run_result(block, names)
            ))
        }
        "visual" if !body.trim().is_empty() => Some(format!(
            "Visual{title} — a Simulation: an interactive figure, given here as its HTML/JavaScript source.\n\n{}",
            fenced("html", body)
        )),
        "visual" => None,
        _ if body.trim().is_empty() => None,
        _ => Some(body.to_string()),
    }
}

/// The Markdown of a Card's Page: its visible Blocks in `order` (then id), joined by blank
/// lines, cut at `MAX_PAGE_CHARS` characters with "…".
fn page_of(board: &Board, card: EntityId, names: &BTreeMap<MemberId, String>) -> String {
    let mut blocks: Vec<(&str, EntityId, &Entity)> = visible(board, EntityKind::Block)
        .filter(|(_, b)| reference(b, "card") == Some(card))
        .map(|(id, b)| (text(b, "order"), id, b))
        .collect();
    blocks.sort_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)));
    let page = blocks
        .iter()
        .filter_map(|(_, _, block)| block_markdown(block, names))
        .collect::<Vec<_>>()
        .join("\n\n");
    match page.char_indices().nth(MAX_PAGE_CHARS) {
        Some((cut, _)) => format!("{}…", &page[..cut]),
        None => page,
    }
}

fn source_fields(source: &Entity) -> Map<String, Value> {
    let mut m = Map::new();
    for field in ["title", "authors", "year", "url", "doi"] {
        put(&mut m, field, text(source, field));
    }
    m
}

/// `get_card`: one live Card with its Page, Sources and Connections. `names` are the people
/// on the team, to say who executed a Run.
pub fn get_card(board: &Board, card: &str, names: &BTreeMap<MemberId, String>) -> ToolResult {
    let id = live_card(board, card)?;
    let Some(entity) = board.get(id) else {
        return Err("There is no such Card.".to_string());
    };
    let mut m = Map::new();
    m.insert("id".into(), json!(id));
    m.insert("title".into(), json!(text(entity, "title")));
    m.insert("status".into(), json!(status_of(entity)));
    m.insert("summary".into(), json!(text(entity, "summary")));
    if let Some(f) = frame_of(&frames(board), entity) {
        m.insert("frame".into(), json!(f));
    }
    m.insert("page".into(), json!(page_of(board, id, names)));

    // A Source attached twice is listed once.
    let attached: BTreeSet<EntityId> = visible(board, EntityKind::Attachment)
        .filter(|(_, a)| reference(a, "card") == Some(id))
        .filter_map(|(_, a)| reference(a, "source"))
        .collect();
    let sources: Vec<Value> = attached
        .iter()
        .filter_map(|s| board.get(*s))
        .map(|s| Value::Object(source_fields(s)))
        .collect();
    m.insert("sources".into(), Value::Array(sources));

    let connections: Vec<Value> = visible(board, EntityKind::Connection)
        .filter_map(|(_, c)| {
            let (from, to) = (reference(c, "from")?, reference(c, "to")?);
            let (other, outgoing) = if from == id {
                (to, true)
            } else if to == id {
                (from, false)
            } else {
                return None;
            };
            let kind = kind_of(c);
            let direction = match (kind, outgoing) {
                ("directed", true) => "out",
                ("directed", false) => "in",
                _ => "none",
            };
            let mut m = Map::new();
            m.insert("other".into(), card_ref(board, other));
            m.insert("direction".into(), json!(direction));
            m.insert("kind".into(), json!(kind));
            put(&mut m, "label", text(c, "label"));
            Some(Value::Object(m))
        })
        .collect();
    m.insert("connections".into(), Value::Array(connections));
    Ok(Value::Object(m))
}

/// `list_connections`: the visible Connections.
pub fn list_connections(board: &Board) -> Value {
    let mut all = visible(board, EntityKind::Connection).filter_map(|(_, c)| {
        let mut m = Map::new();
        m.insert("from".into(), card_ref(board, reference(c, "from")?));
        m.insert("to".into(), card_ref(board, reference(c, "to")?));
        m.insert("kind".into(), json!(kind_of(c)));
        put(&mut m, "label", text(c, "label"));
        Some(Value::Object(m))
    });
    let connections: Vec<Value> = all.by_ref().take(MAX_CONNECTIONS).collect();
    let truncated = all.next().is_some();
    json!({ "connections": connections, "truncated": truncated })
}

/// `list_sources`: the live Sources, each with the live Cards it is attached to.
pub fn list_sources(board: &Board) -> Value {
    let mut cards: BTreeMap<EntityId, BTreeSet<EntityId>> = BTreeMap::new();
    for (_, a) in visible(board, EntityKind::Attachment) {
        if let (Some(source), Some(card)) = (reference(a, "source"), reference(a, "card")) {
            cards.entry(source).or_default().insert(card);
        }
    }
    let mut all = live(board, EntityKind::Source).map(|(id, s)| {
        let mut m = source_fields(s);
        let attached: Vec<Value> = cards
            .get(&id)
            .into_iter()
            .flatten()
            .map(|c| card_ref(board, *c))
            .collect();
        m.insert("cards".into(), Value::Array(attached));
        Value::Object(m)
    });
    let sources: Vec<Value> = all.by_ref().take(MAX_SOURCES).collect();
    let truncated = all.next().is_some();
    json!({ "sources": sources, "truncated": truncated })
}

/// A Card named in a sentence.
fn named(board: &Board, id: Uuid) -> String {
    match title_of(board, EntityId(id)).trim() {
        "" => "an untitled Card".to_string(),
        t => format!("Card \"{t}\""),
    }
}

/// One sentence saying what a Suggestion proposes.
pub fn suggestion_summary(board: &Board, s: &SuggestionRecord) -> String {
    match s.kind {
        SuggestionKind::Source => {
            let source = s.source.clone().unwrap_or_default();
            let mut parts = Vec::new();
            if let Some(t) = &source.title {
                parts.push(format!("\"{t}\""));
            }
            if let Some(d) = &source.doi {
                parts.push(format!("doi:{d}"));
            }
            if let Some(u) = &source.url {
                parts.push(u.clone());
            }
            let card = s
                .card
                .map_or_else(|| "a Card".to_string(), |c| named(board, c));
            format!("Attach the Source {} to {card}", parts.join(", "))
        }
        SuggestionKind::Connection => match &s.connection {
            Some(c) => {
                let label = c
                    .label
                    .as_ref()
                    .map(|l| format!(", labelled \"{l}\""))
                    .unwrap_or_default();
                format!(
                    "Connect {} to {} as {}{label}",
                    named(board, c.from),
                    named(board, c.to),
                    c.kind
                )
            }
            None => "Connect two Cards".to_string(),
        },
    }
}

/// `list_suggestions`: the pending Suggestions given, each in one sentence.
pub fn list_suggestions(board: &Board, pending: &[SuggestionRecord]) -> Value {
    let list: Vec<Value> = pending
        .iter()
        .map(|s| {
            json!({
                "id": s.id,
                "kind": s.kind,
                "summary": suggestion_summary(board, s),
                "reason": s.reason,
            })
        })
        .collect();
    Value::Array(list)
}

#[cfg(test)]
mod tests {
    use super::*;
    use qoop_core::{Fields, Op};

    fn id() -> EntityId {
        EntityId(Uuid::new_v4())
    }

    fn t(s: &str) -> FieldValue {
        FieldValue::Text(s.to_string())
    }

    fn create(board: &mut Board, kind: EntityKind, fields: &[(&str, FieldValue)]) -> EntityId {
        let entity = id();
        let fields: Fields = fields
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        board
            .apply(&Op::Create {
                entity,
                kind,
                fields,
            })
            .unwrap();
        entity
    }

    fn card(board: &mut Board, title: &str, x: f64, y: f64) -> EntityId {
        create(
            board,
            EntityKind::Card,
            &[
                ("title", t(title)),
                ("x", FieldValue::Float(x)),
                ("y", FieldValue::Float(y)),
            ],
        )
    }

    fn connect(board: &mut Board, from: EntityId, to: EntityId, kind: Option<&str>) -> EntityId {
        let mut fields = vec![("from", FieldValue::Ref(from)), ("to", FieldValue::Ref(to))];
        if let Some(k) = kind {
            fields.push(("kind", t(k)));
        }
        create(board, EntityKind::Connection, &fields)
    }

    fn block(board: &mut Board, card: EntityId, order: &str, text: &str) -> EntityId {
        create(
            board,
            EntityKind::Block,
            &[
                ("card", FieldValue::Ref(card)),
                ("type", t("text")),
                ("order", t(order)),
                ("text", t(text)),
            ],
        )
    }

    fn titles(cards: &Value) -> Vec<&str> {
        cards["cards"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["title"].as_str().unwrap())
            .collect()
    }

    #[test]
    fn frame_membership_is_where_the_centre_of_the_card_lies() {
        let mut b = Board::new();
        create(
            &mut b,
            EntityKind::Frame,
            &[
                ("title", t("Theory")),
                ("x", FieldValue::Float(0.0)),
                ("y", FieldValue::Float(0.0)),
                ("w", FieldValue::Float(400.0)),
                ("h", FieldValue::Float(300.0)),
            ],
        );
        // Centre (112 + 250, 66 + 200) = (362, 266): inside.
        let inside = card(&mut b, "Inside", 250.0, 200.0);
        // Its corner is inside, its centre (412, 66) is not.
        card(&mut b, "Straddling", 300.0, 0.0);
        // A Card with no size or place: centre (112, 66).
        create(&mut b, EntityKind::Card, &[("title", t("Origin"))]);

        let all = list_cards(&b, None, None).unwrap();
        assert_eq!(titles(&all), ["Inside", "Origin", "Straddling"]);
        assert_eq!(all["cards"][0]["frame"], "Theory");
        assert_eq!(all["cards"][1]["frame"], "Theory");
        assert!(all["cards"][2].get("frame").is_none());
        assert_eq!(all["truncated"], false);

        let framed = list_cards(&b, None, Some(" theory ")).unwrap();
        assert_eq!(titles(&framed), ["Inside", "Origin"]);
        assert_eq!(framed["cards"][0]["id"], json!(inside));

        let err = list_cards(&b, None, Some("Nope")).unwrap_err();
        assert!(err.contains("no Frame titled \"Nope\""), "{err}");
    }

    #[test]
    fn a_frame_without_a_size_uses_the_default_one() {
        let mut b = Board::new();
        create(&mut b, EntityKind::Frame, &[("title", t("New"))]);
        card(&mut b, "In", 300.0, 200.0); // centre (412, 266) within 520×360
        card(&mut b, "Out", 450.0, 200.0); // centre (562, 266)
        let framed = list_cards(&b, None, Some("New")).unwrap();
        assert_eq!(titles(&framed), ["In"]);
    }

    #[test]
    fn cards_are_filtered_by_a_case_insensitive_query_and_deleted_ones_are_not_listed() {
        let mut b = Board::new();
        let a = card(&mut b, "Spin Glasses", 0.0, 0.0);
        let gone = card(&mut b, "Spin ice", 0.0, 0.0);
        let c = create(
            &mut b,
            EntityKind::Card,
            &[
                ("title", t("Replica trick")),
                ("summary", t("Used for SPIN glass models")),
                ("status", t("reading")),
            ],
        );
        card(&mut b, "Unrelated", 0.0, 0.0);
        b.apply(&Op::Delete { entity: gone }).unwrap();

        let found = list_cards(&b, Some("spin"), None).unwrap();
        assert_eq!(titles(&found), ["Replica trick", "Spin Glasses"]);
        assert_eq!(found["cards"][0]["id"], json!(c));
        assert_eq!(found["cards"][0]["status"], "reading");
        assert_eq!(found["cards"][0]["summary"], "Used for SPIN glass models");
        assert_eq!(found["cards"][1]["id"], json!(a));
        assert_eq!(found["cards"][1]["status"], "idea");
        assert_eq!(found["cards"][1]["summary"], "");
        assert_eq!(titles(&list_cards(&b, None, None).unwrap()).len(), 3);
        assert!(titles(&list_cards(&b, Some("zzz"), None).unwrap()).is_empty());
    }

    #[test]
    fn list_cards_counts_blocks_and_sources_and_flags_truncation() {
        let mut b = Board::new();
        let a = card(&mut b, "A", 0.0, 0.0);
        block(&mut b, a, "a", "one");
        let dropped = block(&mut b, a, "b", "two");
        b.apply(&Op::Delete { entity: dropped }).unwrap();
        let s = create(&mut b, EntityKind::Source, &[("doi", t("10.1/x"))]);
        create(
            &mut b,
            EntityKind::Attachment,
            &[("card", FieldValue::Ref(a)), ("source", FieldValue::Ref(s))],
        );
        let listed = list_cards(&b, None, None).unwrap();
        assert_eq!(listed["cards"][0]["blocks"], 1);
        assert_eq!(listed["cards"][0]["sources"], 1);

        for i in 0..MAX_CARDS {
            card(&mut b, &format!("Card {i:03}"), 0.0, 0.0);
        }
        let listed = list_cards(&b, None, None).unwrap();
        assert_eq!(listed["cards"].as_array().unwrap().len(), MAX_CARDS);
        assert_eq!(listed["truncated"], true);
        let some = list_cards(&b, Some("card 00"), None).unwrap();
        assert_eq!(some["cards"].as_array().unwrap().len(), 10);
        assert_eq!(some["truncated"], false);
    }

    #[test]
    fn get_card_gives_the_page_in_order_with_sources_and_connections_of_every_kind() {
        let mut b = Board::new();
        let a = card(&mut b, "A", 0.0, 0.0);
        let other = card(&mut b, "B", 0.0, 0.0);
        let third = card(&mut b, "C", 0.0, 0.0);
        let gone = card(&mut b, "Gone", 0.0, 0.0);
        block(&mut b, a, "b", "Second");
        block(&mut b, a, "a", "# First");
        block(&mut b, a, "c", "   ");
        let dropped = block(&mut b, a, "ab", "Dropped");
        b.apply(&Op::Delete { entity: dropped }).unwrap();
        block(&mut b, other, "a", "Not mine");

        let s = create(
            &mut b,
            EntityKind::Source,
            &[
                ("title", t("A paper")),
                ("authors", t("Doe, J.")),
                ("year", t("1999")),
                ("url", t("https://example.org/p")),
                ("doi", t("10.1/p")),
            ],
        );
        let attach = |b: &mut Board, card: EntityId, source: EntityId| {
            create(
                b,
                EntityKind::Attachment,
                &[
                    ("card", FieldValue::Ref(card)),
                    ("source", FieldValue::Ref(source)),
                ],
            )
        };
        attach(&mut b, a, s);
        attach(&mut b, a, s);
        let removed = create(&mut b, EntityKind::Source, &[("doi", t("10.1/gone"))]);
        attach(&mut b, a, removed);
        b.apply(&Op::Delete { entity: removed }).unwrap();
        let detached = create(&mut b, EntityKind::Source, &[("doi", t("10.1/detached"))]);
        let link = attach(&mut b, a, detached);
        b.apply(&Op::Delete { entity: link }).unwrap();

        connect(&mut b, a, other, Some("directed"));
        connect(&mut b, third, a, Some("directed"));
        connect(&mut b, other, a, Some("contradicts"));
        let labelled = connect(&mut b, a, third, None);
        b.apply(&Op::Set {
            entity: labelled,
            field: "label".into(),
            value: t("see also"),
        })
        .unwrap();
        connect(&mut b, a, gone, None);
        connect(&mut b, other, third, None);
        let dropped = connect(&mut b, a, other, None);
        b.apply(&Op::Delete { entity: dropped }).unwrap();
        b.apply(&Op::Delete { entity: gone }).unwrap();

        let got = get_card(&b, &a.0.to_string(), &BTreeMap::new()).unwrap();
        assert_eq!(got["id"], json!(a));
        assert_eq!(got["title"], "A");
        assert_eq!(got["status"], "idea");
        assert_eq!(got["page"], "# First\n\nSecond");
        assert_eq!(
            got["sources"],
            json!([{
                "title": "A paper", "authors": "Doe, J.", "year": "1999",
                "url": "https://example.org/p", "doi": "10.1/p"
            }])
        );
        let mut connections: Vec<String> = got["connections"]
            .as_array()
            .unwrap()
            .iter()
            .map(Value::to_string)
            .collect();
        connections.sort();
        let mut expected: Vec<String> = [
            json!({ "other": { "id": other, "title": "B" }, "direction": "out", "kind": "directed" }),
            json!({ "other": { "id": third, "title": "C" }, "direction": "in", "kind": "directed" }),
            json!({ "other": { "id": other, "title": "B" }, "direction": "none", "kind": "contradicts" }),
            json!({ "other": { "id": third, "title": "C" }, "direction": "none", "kind": "related", "label": "see also" }),
        ]
        .iter()
        .map(Value::to_string)
        .collect();
        expected.sort();
        assert_eq!(connections, expected);
    }

    #[test]
    fn get_card_refuses_what_is_not_a_live_card() {
        let mut b = Board::new();
        let a = card(&mut b, "A", 0.0, 0.0);
        let frame = create(&mut b, EntityKind::Frame, &[("title", t("F"))]);
        b.apply(&Op::Delete { entity: a }).unwrap();
        for raw in [
            a.0.to_string(),
            frame.0.to_string(),
            Uuid::new_v4().to_string(),
            "not an id".to_string(),
            String::new(),
        ] {
            let err = get_card(&b, &raw, &BTreeMap::new()).unwrap_err();
            assert!(err.starts_with("There is no Card with id"), "{err}");
        }
        // What is echoed back is one short line.
        let err = get_card(&b, &format!("x\n{}", "y".repeat(500)), &BTreeMap::new()).unwrap_err();
        assert!(!err.contains('\n'));
        assert!(err.chars().count() < 200);
    }

    #[test]
    fn a_long_page_is_cut_at_the_limit_with_an_ellipsis() {
        let mut b = Board::new();
        let a = card(&mut b, "A", 0.0, 0.0);
        block(&mut b, a, "a", &"é".repeat(MAX_PAGE_CHARS - 2));
        let exact = get_card(&b, &a.0.to_string(), &BTreeMap::new()).unwrap();
        assert_eq!(
            exact["page"].as_str().unwrap().chars().count(),
            MAX_PAGE_CHARS - 2
        );
        // Two more characters of separator bring it to the limit exactly: still whole.
        block(&mut b, a, "b", "x");
        let over = get_card(&b, &a.0.to_string(), &BTreeMap::new()).unwrap();
        let page = over["page"].as_str().unwrap();
        assert_eq!(page.chars().count(), MAX_PAGE_CHARS + 1);
        assert!(page.ends_with("\n\n…"));
    }

    #[test]
    fn list_connections_gives_the_visible_ones_and_flags_truncation() {
        let mut b = Board::new();
        let a = card(&mut b, "A", 0.0, 0.0);
        let c = card(&mut b, "B", 0.0, 0.0);
        let gone = card(&mut b, "Gone", 0.0, 0.0);
        connect(&mut b, a, c, Some("directed"));
        connect(&mut b, a, gone, None);
        let dropped = connect(&mut b, c, a, Some("contradicts"));
        b.apply(&Op::Delete { entity: dropped }).unwrap();
        b.apply(&Op::Delete { entity: gone }).unwrap();
        assert_eq!(
            list_connections(&b),
            json!({
                "connections": [{
                    "from": { "id": a, "title": "A" },
                    "to": { "id": c, "title": "B" },
                    "kind": "directed"
                }],
                "truncated": false
            })
        );
        for _ in 0..MAX_CONNECTIONS {
            connect(&mut b, c, a, None);
        }
        let many = list_connections(&b);
        assert_eq!(
            many["connections"].as_array().unwrap().len(),
            MAX_CONNECTIONS
        );
        assert_eq!(many["truncated"], true);
    }

    #[test]
    fn list_sources_gives_live_sources_with_the_live_cards_they_are_attached_to() {
        let mut b = Board::new();
        let a = card(&mut b, "A", 0.0, 0.0);
        let gone = card(&mut b, "Gone", 0.0, 0.0);
        let s = create(
            &mut b,
            EntityKind::Source,
            &[("title", t("Paper")), ("doi", t("10.1/p"))],
        );
        let lonely = create(&mut b, EntityKind::Source, &[("url", t("https://x.org"))]);
        let removed = create(&mut b, EntityKind::Source, &[("doi", t("10.1/gone"))]);
        for (card, source) in [(a, s), (gone, s), (a, removed)] {
            create(
                &mut b,
                EntityKind::Attachment,
                &[
                    ("card", FieldValue::Ref(card)),
                    ("source", FieldValue::Ref(source)),
                ],
            );
        }
        b.apply(&Op::Delete { entity: gone }).unwrap();
        b.apply(&Op::Delete { entity: removed }).unwrap();

        let listed = list_sources(&b);
        assert_eq!(listed["truncated"], false);
        let mut sources = listed["sources"].as_array().unwrap().clone();
        sources.sort_by_key(|s| s.to_string());
        let mut expected = vec![
            json!({ "title": "Paper", "doi": "10.1/p", "cards": [{ "id": a, "title": "A" }] }),
            json!({ "url": "https://x.org", "cards": [] }),
        ];
        expected.sort_by_key(|s| s.to_string());
        assert_eq!(sources, expected);
        let _ = lonely;

        for i in 0..MAX_SOURCES {
            create(
                &mut b,
                EntityKind::Source,
                &[("doi", t(&format!("10.2/{i}")))],
            );
        }
        let many = list_sources(&b);
        assert_eq!(many["sources"].as_array().unwrap().len(), MAX_SOURCES);
        assert_eq!(many["truncated"], true);
    }

    #[test]
    fn branches_are_listed_with_their_parent_and_number_of_changes() {
        let (mut ws, main) = Workspace::new();
        let me = qoop_core::MemberId(Uuid::new_v4());
        let entity = id();
        ws.record(
            main,
            me,
            1,
            Op::Create {
                entity,
                kind: EntityKind::Card,
                fields: Fields::new(),
            },
        )
        .unwrap();
        let head = ws.head(main).unwrap();
        let side = ws.fork("alt", head, me, 2).unwrap();
        ws.record(side, me, 3, Op::Delete { entity }).unwrap();
        ws.record(side, me, 4, Op::Undelete { entity }).unwrap();
        assert_eq!(
            list_branches(&ws),
            json!([
                { "name": "main", "changes": 1 },
                { "name": "alt", "parent": "main", "changes": 2 }
            ])
        );
    }
}
