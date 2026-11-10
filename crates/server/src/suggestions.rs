//! Suggestions (contract §12): what an AI proposes through the tool layer, and a Member
//! accepts, rejects or reopens. Not Research Content, not versioned; never for Guests.
//!
//! There is no HTTP route that creates one: `propose` is called only by the tools.

use axum::Json;
use axum::extract::{Path, State};
use qoop_core::{Board, BranchId, Change, EntityId, EntityKind, MemberId, Op, Workspace};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::app::{Shared, blocking};
use crate::auth::MemberOrAdmin;
use crate::boards::{CheckedOps, changes_after, rejected};
use crate::error::{ApiError, ApiJson, ApiQuery};
use crate::live::Hub;
use crate::store::{
    SuggestedConnection, SuggestedSource, SuggestionKind, SuggestionRecord, SuggestionState,
};
use crate::tools::{live_card, shown};

/// The most ops accepting one Suggestion may carry.
pub const MAX_ACCEPT_OPS: usize = 20;
/// The most pending Suggestions one Branch may have.
pub const MAX_PENDING_PER_BRANCH: usize = 100;
/// Decided Suggestions stay listed this long.
pub const DECIDED_WINDOW_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const MAX_TEXT_CHARS: usize = 500;
const MAX_URL_CHARS: usize = 2000;
const MAX_MODEL_CHARS: usize = 80;
const CONNECTION_KINDS: [&str; 3] = ["related", "directed", "contradicts"];

// ---------------------------------------------------------------- creation rules

/// What `suggest_source` was called with, as sent.
#[derive(Debug, Clone, Default)]
pub struct SourceInput {
    pub card: String,
    pub url: Option<String>,
    pub doi: Option<String>,
    pub title: Option<String>,
    pub authors: Option<String>,
    pub year: Option<String>,
    pub reason: String,
    pub model: Option<String>,
}

/// What `suggest_connection` was called with, as sent.
#[derive(Debug, Clone, Default)]
pub struct ConnectionInput {
    pub from: String,
    pub to: String,
    pub kind: Option<String>,
    pub label: Option<String>,
    pub reason: String,
    pub model: Option<String>,
}

/// A checked proposal, not yet stored.
#[derive(Debug, Clone, PartialEq)]
pub struct Draft {
    pub kind: SuggestionKind,
    pub card: Option<Uuid>,
    pub source: Option<SuggestedSource>,
    pub connection: Option<SuggestedConnection>,
    pub reason: String,
    pub model: Option<String>,
}

/// Trims an optional text; empty counts as absent. Refuses one over `max` characters or
/// with control characters, in a sentence naming the argument.
fn clean(name: &str, value: Option<&str>, max: usize) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    if value.chars().count() > max {
        return Err(format!("`{name}` may be at most {max} characters."));
    }
    if value.chars().any(char::is_control) {
        return Err(format!(
            "`{name}` must be one line without control characters."
        ));
    }
    Ok(Some(value.to_string()))
}

fn clean_reason(reason: &str) -> Result<String, String> {
    clean("reason", Some(reason), MAX_TEXT_CHARS)?.ok_or_else(|| {
        "`reason` is required: say concretely why this belongs on the Board.".to_string()
    })
}

/// An `http://` or `https://` address with something after the scheme and no spaces.
fn is_web_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"));
    rest.is_some_and(|r| !r.is_empty() && !r.starts_with('/'))
        && !url.chars().any(char::is_whitespace)
}

/// Checks a Source proposal against the Board at the Branch head.
pub fn draft_source(board: &Board, input: &SourceInput) -> Result<Draft, String> {
    let card = live_card(board, &input.card)?;
    let url = clean("url", input.url.as_deref(), MAX_URL_CHARS)?;
    if let Some(u) = &url
        && !is_web_url(u)
    {
        return Err("`url` must be an http:// or https:// address.".to_string());
    }
    let doi = clean("doi", input.doi.as_deref(), MAX_TEXT_CHARS)?;
    if url.is_none() && doi.is_none() {
        return Err("A Source needs a `url` or a `doi`.".to_string());
    }
    Ok(Draft {
        kind: SuggestionKind::Source,
        card: Some(card.0),
        source: Some(SuggestedSource {
            url,
            doi,
            title: clean("title", input.title.as_deref(), MAX_TEXT_CHARS)?,
            authors: clean("authors", input.authors.as_deref(), MAX_TEXT_CHARS)?,
            year: clean("year", input.year.as_deref(), MAX_TEXT_CHARS)?,
        }),
        connection: None,
        reason: clean_reason(&input.reason)?,
        model: clean("model", input.model.as_deref(), MAX_MODEL_CHARS)?,
    })
}

/// Checks a Connection proposal against the Board at the Branch head.
pub fn draft_connection(board: &Board, input: &ConnectionInput) -> Result<Draft, String> {
    let from = live_card(board, &input.from)?;
    let to = live_card(board, &input.to)?;
    if from == to {
        return Err("`from` and `to` must be two different Cards.".to_string());
    }
    let kind = match input.kind.as_deref().map(str::trim) {
        None | Some("") => "related",
        Some(k) => CONNECTION_KINDS
            .iter()
            .copied()
            .find(|known| *known == k)
            .ok_or_else(|| {
                format!(
                    "`kind` must be one of related, directed or contradicts, not \"{}\".",
                    shown(k)
                )
            })?,
    };
    Ok(Draft {
        kind: SuggestionKind::Connection,
        card: None,
        source: None,
        connection: Some(SuggestedConnection {
            from: from.0,
            to: to.0,
            kind: kind.to_string(),
            label: clean("label", input.label.as_deref(), MAX_TEXT_CHARS)?,
        }),
        reason: clean_reason(&input.reason)?,
        model: clean("model", input.model.as_deref(), MAX_MODEL_CHARS)?,
    })
}

/// Whether `existing` (a Suggestion of the same Branch) proposes the same thing as
/// `draft`: the same Card and the same doi or url, or the same two Cards in either
/// direction.
pub fn same_proposal(existing: &SuggestionRecord, draft: &Draft) -> bool {
    if existing.kind != draft.kind {
        return false;
    }
    match draft.kind {
        SuggestionKind::Source => {
            let (Some(a), Some(b)) = (&existing.source, &draft.source) else {
                return false;
            };
            let same_doi =
                matches!((&a.doi, &b.doi), (Some(x), Some(y)) if x.eq_ignore_ascii_case(y));
            let same_url = matches!((&a.url, &b.url), (Some(x), Some(y)) if x == y);
            existing.card == draft.card && (same_doi || same_url)
        }
        SuggestionKind::Connection => {
            let (Some(a), Some(b)) = (&existing.connection, &draft.connection) else {
                return false;
            };
            (a.from == b.from && a.to == b.to) || (a.from == b.to && a.to == b.from)
        }
    }
}

/// The Card a Source Suggestion is for, or both Cards of a Connection Suggestion.
fn cards_of(s: &SuggestionRecord) -> impl Iterator<Item = Uuid> {
    let ends = s.connection.as_ref().map(|c| [c.from, c.to]);
    s.card.into_iter().chain(ends.into_iter().flatten())
}

fn is_live_card(board: &Board, id: Uuid) -> bool {
    board
        .get(EntityId(id))
        .is_some_and(|e| e.kind == EntityKind::Card && !e.deleted)
}

/// The Suggestions of a Branch as listed: all pending, plus those decided in the last
/// seven days; newest first.
pub async fn listed(st: &Shared, branch: BranchId) -> Result<Vec<SuggestionRecord>, ApiError> {
    let since = st.clock.now() - DECIDED_WINDOW_MS;
    blocking(st, move |s| s.suggestions(branch, since)).await
}

/// The pending Suggestions of a Branch, newest first.
pub async fn pending(st: &Shared, branch: BranchId) -> Result<Vec<SuggestionRecord>, ApiError> {
    blocking(st, move |s| s.suggestions(branch, i64::MAX)).await
}

/// Sends the Branch's list to its Member and Admin subscribers. Callers hold
/// `Hub::suggestion_order`.
async fn broadcast(st: &Shared, branch: BranchId) -> Result<(), ApiError> {
    let list = listed(st, branch).await?;
    Hub::broadcast_suggestions(st, branch, &list);
    Ok(())
}

/// Stores the Suggestion that `draft` makes of the Board at the head of `branch`, for the
/// Member `who`; an identical pending one is returned instead. The inner `Err` is a
/// sentence for the model. Reads the Workspace and never changes it.
///
/// `ws` is the caller's read guard: holding it means the Board the draft is checked
/// against is still the head when the Suggestion is stored.
pub async fn propose(
    st: &Shared,
    ws: &Workspace,
    branch: BranchId,
    who: MemberId,
    draft: impl FnOnce(&Board) -> Result<Draft, String>,
) -> Result<Result<SuggestionRecord, String>, ApiError> {
    // A moved Workspace takes no Suggestion either (docs/specs/team-move.md, decision 3).
    if crate::local::is_read_only(st) {
        return Ok(Err(crate::local::MOVED_SENTENCE.to_string()));
    }
    let head = ws.head(branch).map_err(ApiError::internal)?;
    let board = ws.board_at(head).map_err(ApiError::internal)?;
    let draft = match draft(&board) {
        Ok(d) => d,
        Err(sentence) => return Ok(Err(sentence)),
    };
    let _order = st.hub.suggestion_order.lock().await;
    let waiting = pending(st, branch).await?;
    if let Some(existing) = waiting.iter().find(|s| same_proposal(s, &draft)) {
        return Ok(Ok(existing.clone()));
    }
    if waiting.len() >= MAX_PENDING_PER_BRANCH {
        return Ok(Err(format!(
            "This Branch already has {MAX_PENDING_PER_BRANCH} pending Suggestions. A Member has to review some before more can be added."
        )));
    }
    let suggestion = SuggestionRecord {
        id: Uuid::new_v4(),
        branch,
        kind: draft.kind,
        card: draft.card,
        source: draft.source,
        connection: draft.connection,
        reason: draft.reason,
        created_by: who,
        model: draft.model,
        created_at: st.clock.now(),
        state: SuggestionState::Pending,
        decided_by: None,
        decided_at: None,
    };
    blocking(st, {
        let suggestion = suggestion.clone();
        move |s| s.insert_suggestion(&suggestion)
    })
    .await?;
    broadcast(st, branch).await?;
    Ok(Ok(suggestion))
}

// ---------------------------------------------------------------- handlers

fn parse_id(raw: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(raw).map_err(|_| ApiError::NotFound)
}

#[derive(Deserialize)]
pub struct ListQuery {
    branch: String,
}

pub async fn list_suggestions(
    State(st): State<Shared>,
    MemberOrAdmin(_): MemberOrAdmin,
    ApiQuery(q): ApiQuery<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let branch = BranchId(parse_id(&q.branch)?);
    if st.workspace.read().await.branch(branch).is_none() {
        return Err(ApiError::NotFound);
    }
    let suggestions = listed(&st, branch).await?;
    Ok(Json(json!({ "suggestions": suggestions })))
}

#[derive(Deserialize)]
pub struct AcceptBody {
    ops: Vec<Op>,
}

/// Applies the ops as an ordinary edit by the caller and marks the Suggestion accepted,
/// in one store transaction: both happen or neither does.
pub async fn accept(
    State(st): State<Shared>,
    MemberOrAdmin(who): MemberOrAdmin,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<AcceptBody>,
) -> Result<Json<Value>, ApiError> {
    let id = parse_id(&id)?;
    if body.ops.is_empty() || body.ops.len() > MAX_ACCEPT_OPS {
        return Err(ApiError::BadRequest(format!(
            "Send between 1 and {MAX_ACCEPT_OPS} ops."
        )));
    }
    // The same checks as `post_ops`: these ops are built by the client.
    let ops = CheckedOps::new(body.ops, who.id())?;

    // As in `post_ops`: the write lock is held through persisting and broadcasting.
    let mut ws = st.workspace.write().await;
    let _order = st.hub.suggestion_order.lock().await;
    let mut suggestion = blocking(&st, move |s| s.suggestion(id))
        .await?
        .ok_or(ApiError::NotFound)?;
    if suggestion.state != SuggestionState::Pending {
        return Err(ApiError::AlreadyDecided);
    }
    let branch = suggestion.branch;
    let before = ws.head(branch).map_err(|_| ApiError::NotFound)?;
    // The core accepts references to deleted Cards, so this is checked here.
    let board = ws.board_at(before).map_err(ApiError::internal)?;
    if !cards_of(&suggestion).all(|card| is_live_card(&board, card)) {
        return Err(ApiError::SuggestionStale);
    }
    let ops = ops.on_board(&ws, before)?;
    let mut next = ws.clone();
    let at = st.clock.now();
    let head = next
        .record_all(branch, who.id(), at, ops)
        .map_err(rejected)?;
    let by = who.id();
    let store = st.store.clone();
    let (next, accepted) = tokio::task::spawn_blocking(move || {
        let accepted = store.save_workspace_accepting(&next, id, by, at);
        (next, accepted)
    })
    .await
    .map_err(|e| ApiError::internal(format!("store task failed: {e}")))?;
    if !accepted? {
        return Err(ApiError::AlreadyDecided);
    }
    *ws = next;
    suggestion.state = SuggestionState::Accepted;
    suggestion.decided_by = Some(by);
    suggestion.decided_at = Some(at);
    let changes = ws
        .branch(branch)
        .and_then(|b| changes_after(b, before.seq))
        .map(<[Change]>::to_vec)
        .unwrap_or_default();
    Hub::broadcast_changes(&st, branch, head.seq, &changes);
    broadcast(&st, branch).await?;
    drop(ws);
    Ok(Json(
        json!({ "suggestion": suggestion, "seq": head.seq, "changes": changes }),
    ))
}

/// Moves a Suggestion from `from` to `to` and tells the Branch's subscribers.
async fn decide(
    st: &Shared,
    raw_id: &str,
    from: SuggestionState,
    to: SuggestionState,
    by: Option<MemberId>,
) -> Result<Json<Value>, ApiError> {
    let id = parse_id(raw_id)?;
    let _order = st.hub.suggestion_order.lock().await;
    let decided = by.map(|by| (by, st.clock.now()));
    let moved = blocking(st, move |s| s.decide_suggestion(id, from, to, decided)).await?;
    let suggestion = blocking(st, move |s| s.suggestion(id))
        .await?
        .ok_or(ApiError::NotFound)?;
    if !moved {
        return Err(ApiError::AlreadyDecided);
    }
    broadcast(st, suggestion.branch).await?;
    Ok(Json(json!({ "suggestion": suggestion })))
}

pub async fn reject(
    State(st): State<Shared>,
    MemberOrAdmin(who): MemberOrAdmin,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    decide(
        &st,
        &id,
        SuggestionState::Pending,
        SuggestionState::Rejected,
        Some(who.id()),
    )
    .await
}

/// Undo of a rejection: a rejected Suggestion becomes pending again.
pub async fn reopen(
    State(st): State<Shared>,
    MemberOrAdmin(_): MemberOrAdmin,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    decide(
        &st,
        &id,
        SuggestionState::Rejected,
        SuggestionState::Pending,
        None,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use qoop_core::{Fields, Value as FieldValue};

    fn card(board: &mut Board, title: &str) -> String {
        let entity = EntityId(Uuid::new_v4());
        let mut fields = Fields::new();
        fields.insert("title".into(), FieldValue::Text(title.into()));
        board
            .apply(&Op::Create {
                entity,
                kind: EntityKind::Card,
                fields,
            })
            .unwrap();
        entity.0.to_string()
    }

    fn source(card: &str) -> SourceInput {
        SourceInput {
            card: card.to_string(),
            doi: Some("10.1000/xyz".into()),
            reason: "It is the original derivation.".into(),
            ..SourceInput::default()
        }
    }

    fn stored(draft: &Draft) -> SuggestionRecord {
        SuggestionRecord {
            id: Uuid::new_v4(),
            branch: BranchId(Uuid::new_v4()),
            kind: draft.kind,
            card: draft.card,
            source: draft.source.clone(),
            connection: draft.connection.clone(),
            reason: draft.reason.clone(),
            created_by: MemberId(Uuid::new_v4()),
            model: None,
            created_at: 0,
            state: SuggestionState::Pending,
            decided_by: None,
            decided_at: None,
        }
    }

    #[test]
    fn a_source_draft_is_trimmed_and_keeps_only_what_was_given() {
        let mut b = Board::new();
        let c = card(&mut b, "A");
        let draft = draft_source(
            &b,
            &SourceInput {
                card: format!(" {c} "),
                url: Some(" https://example.org/paper ".into()),
                doi: Some(String::new()),
                title: Some("  A paper ".into()),
                authors: None,
                year: Some("1999".into()),
                reason: "  Because.  ".into(),
                model: Some(" claude ".into()),
            },
        )
        .unwrap();
        assert_eq!(draft.kind, SuggestionKind::Source);
        assert_eq!(draft.card.unwrap().to_string(), c);
        assert_eq!(
            draft.source,
            Some(SuggestedSource {
                url: Some("https://example.org/paper".into()),
                doi: None,
                title: Some("A paper".into()),
                authors: None,
                year: Some("1999".into()),
            })
        );
        assert_eq!(draft.reason, "Because.");
        assert_eq!(draft.model.as_deref(), Some("claude"));
    }

    #[test]
    fn a_source_needs_a_live_card_a_url_or_doi_and_a_reason() {
        let mut b = Board::new();
        let c = card(&mut b, "A");
        let gone = card(&mut b, "Gone");
        b.apply(&Op::Delete {
            entity: EntityId(Uuid::parse_str(&gone).unwrap()),
        })
        .unwrap();
        let bad = |change: &dyn Fn(&mut SourceInput)| {
            let mut input = source(&c);
            change(&mut input);
            draft_source(&b, &input).unwrap_err()
        };
        assert!(bad(&|i| i.card = gone.clone()).contains("no Card"));
        assert!(bad(&|i| i.card = Uuid::new_v4().to_string()).contains("no Card"));
        assert!(bad(&|i| i.card = "nope".into()).contains("no Card"));
        assert!(bad(&|i| i.doi = None).contains("`url` or a `doi`"));
        assert!(bad(&|i| i.doi = Some("  ".into())).contains("`url` or a `doi`"));
        for url in [
            "ftp://example.org/x",
            "example.org",
            "javascript:alert(1)",
            "https://",
            "http:///x",
            "https://exa mple.org",
        ] {
            assert!(
                bad(&|i| i.url = Some(url.into())).contains("http:// or https://"),
                "{url}"
            );
        }
        let long_url = format!("https://example.org/{}", "x".repeat(MAX_URL_CHARS));
        assert!(bad(&|i| i.url = Some(long_url.clone())).contains("at most 2000"));
        assert!(bad(&|i| i.reason = "   ".into()).contains("`reason` is required"));
        assert!(bad(&|i| i.reason = "x".repeat(501)).contains("`reason` may be at most 500"));
        assert!(bad(&|i| i.reason = "a\nb".into()).contains("`reason` must be one line"));
        assert!(bad(&|i| i.title = Some("x".repeat(501))).contains("`title`"));
        assert!(bad(&|i| i.authors = Some("a\u{0007}b".into())).contains("`authors`"));
        assert!(bad(&|i| i.year = Some("x".repeat(501))).contains("`year`"));
        assert!(bad(&|i| i.doi = Some("x".repeat(501))).contains("`doi`"));
        assert!(bad(&|i| i.model = Some("x".repeat(81))).contains("`model` may be at most 80"));
        // The limits themselves are fine.
        let mut input = source(&c);
        input.reason = "é".repeat(500);
        input.title = Some("x".repeat(500));
        input.model = Some("m".repeat(80));
        input.url = Some(format!("HTTPS://e.org/{}", "x".repeat(MAX_URL_CHARS - 14)));
        assert!(draft_source(&b, &input).is_ok());
    }

    #[test]
    fn a_connection_needs_two_different_live_cards_and_a_known_kind() {
        let mut b = Board::new();
        let a = card(&mut b, "A");
        let c = card(&mut b, "B");
        let input = |from: &str, to: &str| ConnectionInput {
            from: from.into(),
            to: to.into(),
            reason: "B refines A.".into(),
            ..ConnectionInput::default()
        };
        let draft = draft_connection(&b, &input(&a, &c)).unwrap();
        let conn = draft.connection.clone().unwrap();
        assert_eq!(
            (
                conn.from.to_string(),
                conn.to.to_string(),
                conn.kind.as_str()
            ),
            (a.clone(), c.clone(), "related")
        );
        assert_eq!(conn.label, None);
        assert_eq!(draft.card, None);

        let mut directed = input(&a, &c);
        directed.kind = Some("directed".into());
        directed.label = Some(" leads to ".into());
        let conn = draft_connection(&b, &directed).unwrap().connection.unwrap();
        assert_eq!(conn.kind, "directed");
        assert_eq!(conn.label.as_deref(), Some("leads to"));

        assert!(
            draft_connection(&b, &input(&a, &a))
                .unwrap_err()
                .contains("two different Cards")
        );
        assert!(
            draft_connection(&b, &input(&a, &Uuid::new_v4().to_string()))
                .unwrap_err()
                .contains("no Card")
        );
        let mut odd = input(&a, &c);
        odd.kind = Some("causes".into());
        assert!(
            draft_connection(&b, &odd)
                .unwrap_err()
                .contains("related, directed or contradicts")
        );
        let mut long = input(&a, &c);
        long.label = Some("x".repeat(501));
        assert!(draft_connection(&b, &long).unwrap_err().contains("`label`"));
        let mut silent = input(&a, &c);
        silent.reason = String::new();
        assert!(
            draft_connection(&b, &silent)
                .unwrap_err()
                .contains("`reason` is required")
        );
    }

    #[test]
    fn the_same_proposal_is_the_same_card_and_doi_or_url_or_the_same_pair_of_cards() {
        let mut b = Board::new();
        let a = card(&mut b, "A");
        let c = card(&mut b, "B");
        let d = card(&mut b, "C");
        let first = stored(&draft_source(&b, &source(&a)).unwrap());

        let mut upper = source(&a);
        upper.doi = Some("10.1000/XYZ".into());
        upper.title = Some("Another title".into());
        assert!(same_proposal(&first, &draft_source(&b, &upper).unwrap()));
        assert!(!same_proposal(
            &first,
            &draft_source(&b, &source(&c)).unwrap()
        ));
        let mut other_doi = source(&a);
        other_doi.doi = Some("10.1000/abc".into());
        assert!(!same_proposal(
            &first,
            &draft_source(&b, &other_doi).unwrap()
        ));

        let mut by_url = source(&a);
        by_url.doi = None;
        by_url.url = Some("https://example.org/p".into());
        let with_url = stored(&draft_source(&b, &by_url).unwrap());
        assert!(!same_proposal(&first, &draft_source(&b, &by_url).unwrap()));
        assert!(same_proposal(
            &with_url,
            &draft_source(&b, &by_url).unwrap()
        ));
        by_url.url = Some("https://example.org/q".into());
        assert!(!same_proposal(
            &with_url,
            &draft_source(&b, &by_url).unwrap()
        ));

        let pair = |from: &str, to: &str, kind: &str| {
            draft_connection(
                &b,
                &ConnectionInput {
                    from: from.into(),
                    to: to.into(),
                    kind: Some(kind.into()),
                    reason: "r".into(),
                    ..ConnectionInput::default()
                },
            )
            .unwrap()
        };
        let link = stored(&pair(&a, &c, "related"));
        assert!(same_proposal(&link, &pair(&a, &c, "directed")));
        assert!(same_proposal(&link, &pair(&c, &a, "related")));
        assert!(!same_proposal(&link, &pair(&a, &d, "related")));
        assert!(!same_proposal(
            &link,
            &draft_source(&b, &source(&a)).unwrap()
        ));
        assert!(!same_proposal(&first, &pair(&a, &c, "related")));
    }
}
