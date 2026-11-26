//! Comments and the For you list (docs/specs/team-move.md, decision 9 and Contract B;
//! api.md §19): one thread per Card, outside versioning like To-dos — the same on every
//! Branch, not in History, kept when the Card is removed. Members and Admins only; Guests
//! get `403` everywhere. The same in a Team and a Local Workspace.

use std::collections::{BTreeMap, HashSet};

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use infall_core::MemberId;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::app::{Shared, blocking};
use crate::auth::MemberOrAdmin;
use crate::error::{ApiError, ApiJson};
use crate::live::Hub;
use crate::store::{CommentRecord, ForYouRecord, Role};

/// The longest a Comment's text may be, in characters, after trimming.
pub const MAX_COMMENT_CHARS: usize = 10_000;
/// How many entries a Member's For you list keeps: the newest.
pub const FOR_YOU_KEEP: usize = 200;

/// A Comment as the API shows it.
#[derive(Serialize)]
pub struct CommentView {
    id: Uuid,
    author: MemberId,
    text: String,
    mentions: Vec<MemberId>,
    created_at: i64,
    edited_at: Option<i64>,
}

impl From<&CommentRecord> for CommentView {
    fn from(c: &CommentRecord) -> CommentView {
        CommentView {
            id: c.id,
            author: c.author,
            text: c.text.clone(),
            mentions: c.mentions.clone(),
            created_at: c.created_at,
            edited_at: c.edited_at,
        }
    }
}

#[derive(Serialize)]
struct ForYouView {
    comment: Uuid,
    card: Uuid,
    author: MemberId,
    at: i64,
    seen: bool,
    /// The first line of the Comment as it reads now, as plain text (`snippet`); `None`
    /// when the Comment is gone.
    snippet: Option<String>,
}

impl ForYouView {
    fn new(e: &ForYouRecord, comment: Option<&CommentRecord>) -> ForYouView {
        ForYouView {
            comment: e.comment,
            card: e.card,
            author: e.author,
            at: e.at,
            seen: e.seen,
            snippet: comment.map(|c| snippet(&c.text)),
        }
    }
}

/// The longest a For you entry's `snippet` is, in characters, with the `…` that ends a cut one.
pub const SNIPPET_CHARS: usize = 140;

/// The first line of a Comment that has words, as plain text, for a For you entry and the
/// short notice: a fence or a lone `$$` is skipped; a heading's `#`, a quote's `>` and a
/// list's `-` or `1.` are dropped, and so are the inline marks a Page's text block knows
/// (`**`, `*` around words, `` ` ``, `$`, a link's brackets and address, keeping its text);
/// white space is collapsed and the line cut at a word to `SNIPPET_CHARS` with `…`.
pub fn snippet(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("```") && *l != "$$")
        .unwrap_or("");
    let plain = strip_inline(strip_block_marks(line));
    let words: Vec<&str> = plain.split_whitespace().collect();
    let line = words.join(" ");
    if line.chars().count() <= SNIPPET_CHARS {
        return line;
    }
    let mut out = String::new();
    for word in words {
        let room = SNIPPET_CHARS - 1;
        let have = out.chars().count();
        let need = word.chars().count() + usize::from(!out.is_empty());
        if have + need > room {
            if out.is_empty() {
                out = word.chars().take(room).collect();
            }
            break;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    out.push('…');
    out
}

/// A line without the marks that start a heading, a quote or a list item.
fn strip_block_marks(mut line: &str) -> &str {
    loop {
        let before = line;
        if let Some(rest) = line.strip_prefix('>') {
            line = rest.trim_start();
        }
        let hashes = line.len() - line.trim_start_matches('#').len();
        if (1..=3).contains(&hashes) && line[hashes..].starts_with([' ', '\t']) {
            line = line[hashes..].trim_start();
        }
        if let Some(rest) = line.strip_prefix("- ") {
            line = rest.trim_start();
        }
        let digits = line.len() - line.trim_start_matches(|c: char| c.is_ascii_digit()).len();
        if (1..=9).contains(&digits) && line[digits..].starts_with(". ") {
            line = line[digits + 2..].trim_start();
        }
        if line == before {
            return line;
        }
    }
}

/// Inline marks dropped: `**`, a `*` that opens or closes a word (not one between spaces or
/// inside a word, as in `2 * 3` or `a*b`), backticks, `$`, and `[text](address)` as `text`.
fn strip_inline(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '`' | '$' => {}
            '*' => {
                let mut j = i;
                while j < chars.len() && chars[j] == '*' {
                    j += 1;
                }
                let before = i.checked_sub(1).map(|k| chars[k]);
                let after = chars.get(j).copied();
                let space = |c: Option<char>| c.is_none_or(|c| c.is_whitespace());
                let word = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric());
                // Kept only alone between spaces or inside a word.
                let keep = j - i == 1
                    && ((space(before) && space(after)) || (word(before) && word(after)));
                if keep {
                    out.push('*');
                }
                i = j;
                continue;
            }
            '[' => {
                // `[text](address)`: the text alone.
                if let Some(close) = chars[i + 1..].iter().position(|&c| c == ']') {
                    let close = i + 1 + close;
                    if chars.get(close + 1) == Some(&'(')
                        && let Some(end) = chars[close + 2..].iter().position(|&c| c == ')')
                    {
                        out.push_str(&strip_inline(
                            &chars[i + 1..close].iter().collect::<String>(),
                        ));
                        i = close + 2 + end + 1;
                        continue;
                    }
                }
                out.push('[');
            }
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
        i += 1;
    }
    out
}

fn parse_id(raw: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(raw).map_err(|_| ApiError::NotFound)
}

/// Trims the text and checks it: 1 to 10 000 characters, no control characters but line
/// breaks and tabs.
fn clean_text(text: &str) -> Result<String, ApiError> {
    let text = text.trim();
    let bad = text
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\t' | '\r'));
    if text.is_empty() || text.chars().count() > MAX_COMMENT_CHARS || bad {
        return Err(ApiError::BadRequest(format!(
            "A Comment must be 1 to {MAX_COMMENT_CHARS} characters of text."
        )));
    }
    Ok(text.to_string())
}

/// The mentioned ids, each once, in the order given; every one must be a Member or an Admin
/// (a name that came with a Workspace file included), never a Guest.
async fn clean_mentions(st: &Shared, raw: &[String]) -> Result<Vec<MemberId>, ApiError> {
    const NOT_A_MEMBER: &str = "Every mention must be the id of a Member.";
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    let members = blocking(st, |s| s.members()).await?;
    let known: HashSet<MemberId> = members
        .iter()
        .filter(|m| m.role != Role::Guest)
        .map(|m| m.id)
        .collect();
    let mut out: Vec<MemberId> = Vec::new();
    for id in raw {
        let id = Uuid::parse_str(id)
            .map(MemberId)
            .map_err(|_| ApiError::BadRequest(NOT_A_MEMBER.to_string()))?;
        if !known.contains(&id) {
            return Err(ApiError::BadRequest(NOT_A_MEMBER.to_string()));
        }
        if !out.contains(&id) {
            out.push(id);
        }
    }
    Ok(out)
}

/// Sends each of `members` their unseen count. Callers hold `Hub::comment_order`.
async fn send_counts(st: &Shared, members: &[MemberId]) -> Result<(), ApiError> {
    for &m in members {
        let unseen = blocking(st, move |s| s.for_you(m))
            .await?
            .iter()
            .filter(|e| !e.seen)
            .count();
        Hub::send_for_you(st, m, unseen);
    }
    Ok(())
}

/// `GET /api/cards/{card}/comments`.
pub async fn list(
    State(st): State<Shared>,
    MemberOrAdmin(_): MemberOrAdmin,
    Path(card): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let card = parse_id(&card)?;
    let (resolved, comments) = blocking(&st, move |s| s.comments(card)).await?;
    let views: Vec<CommentView> = comments.iter().map(CommentView::from).collect();
    Ok(Json(json!({ "resolved": resolved, "comments": views })))
}

#[derive(Deserialize)]
pub struct NewComment {
    text: String,
    #[serde(default)]
    mentions: Vec<String>,
}

/// `POST /api/cards/{card}/comments`: `201` and the Comment. The Card need not exist on any
/// Branch: a thread outlives its Card.
pub async fn create(
    State(st): State<Shared>,
    MemberOrAdmin(who): MemberOrAdmin,
    Path(card): Path<String>,
    ApiJson(body): ApiJson<NewComment>,
) -> Result<(StatusCode, Json<CommentView>), ApiError> {
    let card = parse_id(&card)?;
    let text = clean_text(&body.text)?;
    let mentions = clean_mentions(&st, &body.mentions).await?;
    let comment = CommentRecord {
        id: Uuid::new_v4(),
        card,
        author: who.id(),
        text,
        mentions,
        created_at: st.clock.now(),
        edited_at: None,
    };
    // Nobody is told that they mentioned themself.
    let notify: Vec<MemberId> = comment
        .mentions
        .iter()
        .copied()
        .filter(|m| *m != who.id())
        .collect();
    let _order = st.hub.comment_order.lock().await;
    blocking(&st, {
        let comment = comment.clone();
        let notify = notify.clone();
        move |s| s.insert_comment(&comment, &notify, FOR_YOU_KEEP)
    })
    .await?;
    Hub::broadcast_comments(&st, card);
    send_counts(&st, &notify).await?;
    Ok((StatusCode::CREATED, Json(CommentView::from(&comment))))
}

#[derive(Deserialize)]
pub struct EditComment {
    text: String,
    /// Absent: the mentions stay as they are.
    mentions: Option<Vec<String>>,
}

/// `PATCH /api/comments/{id}`: its author only. Only Members mentioned now and not before
/// are told.
pub async fn edit(
    State(st): State<Shared>,
    MemberOrAdmin(who): MemberOrAdmin,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<EditComment>,
) -> Result<Json<CommentView>, ApiError> {
    let id = parse_id(&id)?;
    let text = clean_text(&body.text)?;
    let mentions = match &body.mentions {
        Some(raw) => Some(clean_mentions(&st, raw).await?),
        None => None,
    };
    let _order = st.hub.comment_order.lock().await;
    let mut comment = blocking(&st, move |s| s.comment(id))
        .await?
        .ok_or(ApiError::NotFound)?;
    if comment.author != who.id() {
        return Err(ApiError::Forbidden("Only its author can change a Comment."));
    }
    let before: HashSet<MemberId> = comment.mentions.iter().copied().collect();
    comment.text = text;
    if let Some(m) = mentions {
        comment.mentions = m;
    }
    comment.edited_at = Some(st.clock.now());
    let notify: Vec<MemberId> = comment
        .mentions
        .iter()
        .copied()
        .filter(|m| !before.contains(m) && *m != who.id())
        .collect();
    let stored = blocking(&st, {
        let comment = comment.clone();
        let notify = notify.clone();
        move |s| s.update_comment(&comment, &notify, FOR_YOU_KEEP)
    })
    .await?;
    if !stored {
        return Err(ApiError::NotFound);
    }
    Hub::broadcast_comments(&st, comment.card);
    send_counts(&st, &notify).await?;
    Ok(Json(CommentView::from(&comment)))
}

/// `DELETE /api/comments/{id}`: its author, or an Admin.
pub async fn delete(
    State(st): State<Shared>,
    MemberOrAdmin(who): MemberOrAdmin,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let id = parse_id(&id)?;
    let _order = st.hub.comment_order.lock().await;
    let comment = blocking(&st, move |s| s.comment(id))
        .await?
        .ok_or(ApiError::NotFound)?;
    if comment.author != who.id() && who.member.role != Role::Admin {
        return Err(ApiError::Forbidden(
            "Only its author or an Admin can delete a Comment.",
        ));
    }
    let had = blocking(&st, move |s| s.delete_comment(id))
        .await?
        .ok_or(ApiError::NotFound)?;
    Hub::broadcast_comments(&st, comment.card);
    send_counts(&st, &had).await?;
    Ok(Json(json!({})))
}

#[derive(Deserialize)]
pub struct Resolved {
    resolved: bool,
}

/// `PUT /api/cards/{card}/comments/resolved`: any Member marks a thread resolved or reopens
/// it. `404` for a Card without Comments.
pub async fn set_resolved(
    State(st): State<Shared>,
    MemberOrAdmin(who): MemberOrAdmin,
    Path(card): Path<String>,
    ApiJson(body): ApiJson<Resolved>,
) -> Result<Json<Value>, ApiError> {
    let card = parse_id(&card)?;
    let _order = st.hub.comment_order.lock().await;
    let (was, comments) = blocking(&st, move |s| s.comments(card)).await?;
    if comments.is_empty() {
        return Err(ApiError::NotFound);
    }
    if was != body.resolved {
        let (by, at, resolved) = (who.id(), st.clock.now(), body.resolved);
        blocking(&st, move |s| s.set_thread_resolved(card, resolved, by, at)).await?;
        Hub::broadcast_comments(&st, card);
    }
    Ok(Json(json!({ "resolved": body.resolved })))
}

/// `GET /api/comments/counts`: for every Card with a thread, how many Comments it has
/// (`open`, whether or not it is resolved) and whether it is resolved.
pub async fn counts(
    State(st): State<Shared>,
    MemberOrAdmin(_): MemberOrAdmin,
) -> Result<Json<Value>, ApiError> {
    let counts = blocking(&st, |s| s.comment_counts()).await?;
    let map: BTreeMap<String, Value> = counts
        .into_iter()
        .map(|(card, n, resolved)| (card.to_string(), json!({ "open": n, "resolved": resolved })))
        .collect();
    Ok(Json(json!(map)))
}

/// `GET /api/for-you`: the caller's mentions, newest first, at most 200.
pub async fn for_you(
    State(st): State<Shared>,
    MemberOrAdmin(who): MemberOrAdmin,
) -> Result<Json<Value>, ApiError> {
    let me = who.id();
    // Each entry with its Comment as it reads now: an edit shows its new text.
    let views = blocking(&st, move |s| {
        s.for_you(me)?
            .iter()
            .map(|e| Ok(ForYouView::new(e, s.comment(e.comment)?.as_ref())))
            .collect::<Result<Vec<ForYouView>, _>>()
    })
    .await?;
    Ok(Json(json!({ "items": views })))
}

#[derive(Deserialize)]
pub struct Seen {
    up_to: Uuid,
}

/// `POST /api/for-you/seen`: marks seen the entry of that Comment and every older one.
/// `404` when the caller's list has no entry for it. Answers the unseen count left.
pub async fn seen(
    State(st): State<Shared>,
    MemberOrAdmin(who): MemberOrAdmin,
    ApiJson(body): ApiJson<Seen>,
) -> Result<Json<Value>, ApiError> {
    let me = who.id();
    let up_to = body.up_to;
    let _order = st.hub.comment_order.lock().await;
    if !blocking(&st, move |s| s.mark_for_you_seen(me, up_to)).await? {
        return Err(ApiError::NotFound);
    }
    let unseen = blocking(&st, move |s| s.for_you(me))
        .await?
        .iter()
        .filter(|e| !e.seen)
        .count();
    Hub::send_for_you(&st, me, unseen);
    Ok(Json(json!({ "count": unseen })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_snippet_is_the_first_line_with_words_without_markup() {
        assert_eq!(
            snippet("  \n\nHave a **look** at *this*\nsecond"),
            "Have a look at this"
        );
        assert_eq!(snippet("```\ncode\n```"), "code");
        assert_eq!(snippet("$$\nx^2\n$$"), "x^2");
        assert_eq!(snippet("## Heading `code`"), "Heading code");
        assert_eq!(snippet("> - 1. quoted item"), "quoted item");
        assert_eq!(
            snippet("see [the paper](https://example.org/a) on $\\alpha$"),
            "see the paper on \\alpha"
        );
        assert_eq!(snippet("2 * 3 and a*b, **bold**"), "2 * 3 and a*b, bold");
        assert_eq!(snippet("[not a link] (x)"), "[not a link] (x)");
        assert_eq!(snippet("tab\there"), "tab here");
        assert_eq!(snippet("#hashtag stays"), "#hashtag stays");
        assert_eq!(snippet("<b>html</b> stays text"), "<b>html</b> stays text");
    }

    #[test]
    fn an_entry_whose_comment_is_gone_has_no_snippet() {
        let e = ForYouRecord {
            comment: Uuid::new_v4(),
            card: Uuid::new_v4(),
            author: MemberId(Uuid::new_v4()),
            at: 1,
            seen: false,
        };
        let v = serde_json::to_value(ForYouView::new(&e, None)).unwrap();
        assert_eq!(v["snippet"], Value::Null);
    }

    #[test]
    fn a_long_snippet_is_cut_at_a_word() {
        let long = "word ".repeat(100);
        let s = snippet(&long);
        assert!(s.chars().count() <= SNIPPET_CHARS);
        assert!(s.ends_with("word…"), "{s}");
        let one = "x".repeat(500);
        assert_eq!(snippet(&one).chars().count(), SNIPPET_CHARS);
        let exact = "y".repeat(SNIPPET_CHARS);
        assert_eq!(snippet(&exact), exact);
    }
}
