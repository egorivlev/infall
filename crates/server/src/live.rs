//! Live updates over WebSocket (contract §7): subscriptions, broadcast and presence; and
//! who is editing a Page (contract §11), which lives only here.
//!
//! Guests (contract §13) get none of that: after `subscribed` their connection is only ever
//! sent `refresh` frames, and they are not part of presence.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use axum::extract::State;
use axum::extract::ws::{
    Message, Utf8Bytes, WebSocket, WebSocketUpgrade, rejection::WebSocketUpgradeRejection,
};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use qoop_core::{BranchId, Change, Checkpoint, MemberId};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError;
use tokio::time::Instant;
use uuid::Uuid;

use crate::app::Shared;
use crate::auth::{SignedIn, live_session, origin_allowed};
use crate::boards::{BranchInfo, changes_after, may_read};
use crate::error::ApiError;
use crate::store::{Role, SuggestionRecord, TodoRecord};

const PING_EVERY: Duration = Duration::from_secs(30);
const MAX_UNANSWERED_PINGS: u32 = 2;
const MAX_CLIENT_MESSAGE: usize = 64 * 1024;
const CHANNEL_CAPACITY: usize = 1024;
/// A Guest gets at most one `refresh` frame in this long (contract §13).
const REFRESH_EVERY: Duration = Duration::from_millis(500);

/// What is fanned out to every connection; each one forwards what concerns it.
#[derive(Debug, Clone)]
enum Event {
    /// A `changes` frame; `seq` is the head after them.
    Changes {
        branch: BranchId,
        seq: u64,
        frame: Utf8Bytes,
    },
    /// A `presence` frame; `version` grows with every presence change on any Branch.
    Presence {
        branch: BranchId,
        version: u64,
        frame: Utf8Bytes,
    },
    /// A `checkpoint` frame, for the Branch's Member and Admin subscribers.
    Checkpoint { branch: BranchId, frame: Utf8Bytes },
    /// A `branches` frame, for every connected Member and Admin.
    Branches { frame: Utf8Bytes },
    /// A `todos` frame, for every connected Member and Admin; `version` grows with every
    /// To-do change.
    Todos { version: u64, frame: Utf8Bytes },
    /// An `editing` frame; `version` grows with every change of holders on any Branch.
    Editing {
        branch: BranchId,
        version: u64,
        frame: Utf8Bytes,
    },
    /// A `suggestions` frame, for the Branch's Member and Admin subscribers; `version` grows
    /// with every Suggestion change on any Branch.
    Suggestions {
        branch: BranchId,
        version: u64,
        frame: Utf8Bytes,
    },
    /// The Member's account is gone: close their connections.
    Kick { member: MemberId },
    /// A `comments` frame (a thread changed), for every connected Member and Admin.
    Comments { frame: Utf8Bytes },
    /// A `for_you` frame, for the connections of that one Member.
    ForYou { member: MemberId, frame: Utf8Bytes },
    /// The whole Workspace was replaced (a Workspace file was brought in): every connection
    /// catches up as after missed frames.
    Resync,
}

#[derive(Default)]
struct Presence {
    /// Per Branch, how many subscribed connections each Member has.
    counts: HashMap<BranchId, BTreeMap<MemberId, usize>>,
    version: u64,
}

/// Everyone who claimed the Page of one Card, in arrival order; the first holds it.
struct Claims {
    /// The server clock when the current holder became holder.
    since: i64,
    /// Connection id and its Member.
    claimants: VecDeque<(u64, MemberId)>,
}

/// Who is editing which Page (the soft lock). Never stored.
#[derive(Default)]
struct Editing {
    /// Per Branch and Card. A connection is in at most one queue.
    cards: HashMap<BranchId, BTreeMap<Uuid, Claims>>,
    version: u64,
}

/// The fan-out, the presence table and the soft lock.
pub struct Hub {
    tx: broadcast::Sender<Event>,
    presence: Mutex<Presence>,
    editing: Mutex<Editing>,
    next_connection: AtomicU64,
    /// Held across a To-do change and its `todos` frame, so frames go out in the order of
    /// the changes.
    pub todo_order: tokio::sync::Mutex<()>,
    /// How many `todos` frames have been broadcast; changed only under `todo_order`.
    todos_version: AtomicU64,
    /// Held across a Suggestion change and its `suggestions` frame, so the rules are
    /// checked against what is then changed and frames go out in the order of the changes.
    /// Taken after the Workspace lock by whoever needs both.
    pub suggestion_order: tokio::sync::Mutex<()>,
    /// How many `suggestions` frames have been broadcast; changed only under
    /// `suggestion_order`.
    suggestions_version: AtomicU64,
    /// Held across a Comment change and its frames, so they go out in the order of the
    /// changes.
    pub comment_order: tokio::sync::Mutex<()>,
}

impl Default for Hub {
    fn default() -> Hub {
        Hub {
            tx: broadcast::channel(CHANNEL_CAPACITY).0,
            presence: Mutex::new(Presence::default()),
            editing: Mutex::new(Editing::default()),
            next_connection: AtomicU64::new(0),
            todo_order: tokio::sync::Mutex::new(()),
            todos_version: AtomicU64::new(0),
            suggestion_order: tokio::sync::Mutex::new(()),
            suggestions_version: AtomicU64::new(0),
            comment_order: tokio::sync::Mutex::new(()),
        }
    }
}

fn changes_frame(branch: BranchId, seq: u64, changes: &[Change]) -> Utf8Bytes {
    json!({ "type": "changes", "branch": branch, "seq": seq, "changes": changes })
        .to_string()
        .into()
}

fn presence_frame(branch: BranchId, members: &BTreeMap<MemberId, usize>) -> Utf8Bytes {
    // Sorted as strings, which for lowercase uuids is the same as the map's order.
    let ids: Vec<String> = members.keys().map(|m| m.0.to_string()).collect();
    json!({ "type": "presence", "branch": branch, "members": ids })
        .to_string()
        .into()
}

fn branches_frame(branches: &[BranchInfo]) -> Utf8Bytes {
    json!({ "type": "branches", "branches": branches })
        .to_string()
        .into()
}

fn todos_frame(todos: &[TodoRecord]) -> Utf8Bytes {
    json!({ "type": "todos", "todos": todos })
        .to_string()
        .into()
}

fn suggestions_frame(branch: BranchId, suggestions: &[SuggestionRecord]) -> Utf8Bytes {
    json!({ "type": "suggestions", "branch": branch, "suggestions": suggestions })
        .to_string()
        .into()
}

/// One entry per Card that has a holder, ordered by Card id.
fn editing_frame(branch: BranchId, cards: Option<&BTreeMap<Uuid, Claims>>) -> Utf8Bytes {
    let editors: Vec<serde_json::Value> = cards
        .into_iter()
        .flatten()
        .filter_map(|(card, claims)| {
            let (_, member) = claims.claimants.front()?;
            Some(json!({ "card": card, "member": member, "since": claims.since }))
        })
        .collect();
    json!({ "type": "editing", "branch": branch, "editors": editors })
        .to_string()
        .into()
}

fn refresh_frame(branch: BranchId, seq: u64) -> Utf8Bytes {
    json!({ "type": "refresh", "branch": branch, "seq": seq })
        .to_string()
        .into()
}

fn error_frame(code: &str, message: &str) -> Utf8Bytes {
    json!({ "type": "error", "code": code, "message": message })
        .to_string()
        .into()
}

impl Hub {
    fn presence(&self) -> MutexGuard<'_, Presence> {
        match self.presence.lock() {
            Ok(p) => p,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// Sends one `changes` frame to every subscriber of `branch`. Called while the
    /// Workspace write lock is held, so frames go out in seq order.
    pub fn broadcast_changes(st: &Shared, branch: BranchId, seq: u64, changes: &[Change]) {
        let frame = changes_frame(branch, seq, changes);
        // An error only means nobody is listening.
        let _ = st.hub.tx.send(Event::Changes { branch, seq, frame });
    }

    /// Sends one `checkpoint` frame to every Member and Admin subscribed to `branch`.
    /// Called while the Workspace write lock is held.
    pub fn broadcast_checkpoint(st: &Shared, branch: BranchId, checkpoint: &Checkpoint) {
        let frame = json!({ "type": "checkpoint", "branch": branch, "checkpoint": checkpoint })
            .to_string()
            .into();
        let _ = st.hub.tx.send(Event::Checkpoint { branch, frame });
    }

    /// Sends the full Branch list to every connected Member and Admin, never to Guests.
    /// Called while the Workspace write lock is held.
    pub fn broadcast_branches(st: &Shared, branches: &[BranchInfo]) {
        let frame = branches_frame(branches);
        let _ = st.hub.tx.send(Event::Branches { frame });
    }

    /// Sends the full To-do list to every connected Member and Admin, never to Guests.
    /// Called while `todo_order` is held.
    pub fn broadcast_todos(st: &Shared, todos: &[TodoRecord]) {
        let frame = todos_frame(todos);
        let version = st.hub.todos_version.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = st.hub.tx.send(Event::Todos { version, frame });
    }

    /// Sends the Suggestion list of `branch` to every Member and Admin subscribed to it,
    /// never to Guests. Called while `suggestion_order` is held.
    pub fn broadcast_suggestions(st: &Shared, branch: BranchId, suggestions: &[SuggestionRecord]) {
        let frame = suggestions_frame(branch, suggestions);
        let version = st.hub.suggestions_version.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = st.hub.tx.send(Event::Suggestions {
            branch,
            version,
            frame,
        });
    }

    fn editing(&self) -> MutexGuard<'_, Editing> {
        match self.editing.lock() {
            Ok(e) => e,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// The current `editing` frame of `branch` and the editing version.
    fn current_editing(&self, branch: BranchId) -> (Utf8Bytes, u64) {
        let e = self.editing();
        (editing_frame(branch, e.cards.get(&branch)), e.version)
    }

    /// Connection `conn` of `member` now edits the Page of `card` on `branch`, or nothing.
    /// Any claim it had on that Branch ends first, and the next claimant of that Card (if
    /// any) becomes its holder at `now`. Claiming the Card it already claims changes
    /// nothing. Broadcasts `editing` if the holders of the Branch changed.
    fn set_editing(
        &self,
        conn: u64,
        member: MemberId,
        branch: BranchId,
        card: Option<Uuid>,
        now: i64,
    ) {
        let mut e = self.editing();
        let cards = e.cards.entry(branch).or_default();
        let already = card.is_some_and(|c| {
            cards
                .get(&c)
                .is_some_and(|q| q.claimants.iter().any(|(id, _)| *id == conn))
        });
        let mut changed = false;
        if !already {
            let held = cards.iter().find_map(|(c, q)| {
                let pos = q.claimants.iter().position(|(id, _)| *id == conn)?;
                Some((*c, pos))
            });
            if let Some((c, pos)) = held
                && let Some(q) = cards.get_mut(&c)
            {
                q.claimants.remove(pos);
                if pos == 0 {
                    // The holder left: the next in line holds it from now.
                    changed = true;
                    q.since = now;
                }
                if q.claimants.is_empty() {
                    cards.remove(&c);
                }
            }
            if let Some(c) = card {
                let q = cards.entry(c).or_insert_with(|| Claims {
                    since: now,
                    claimants: VecDeque::new(),
                });
                changed |= q.claimants.is_empty();
                q.claimants.push_back((conn, member));
            }
        }
        if cards.is_empty() {
            e.cards.remove(&branch);
        }
        if changed {
            e.version += 1;
            let version = e.version;
            let frame = editing_frame(branch, e.cards.get(&branch));
            let _ = self.tx.send(Event::Editing {
                branch,
                version,
                frame,
            });
        }
    }

    /// Tells every connected Member and Admin that the thread of `card` changed.
    pub fn broadcast_comments(st: &Shared, card: Uuid) {
        let frame = json!({ "type": "comments", "card": card })
            .to_string()
            .into();
        let _ = st.hub.tx.send(Event::Comments { frame });
    }

    /// Tells `member`'s connections how many unseen entries their For you list has.
    pub fn send_for_you(st: &Shared, member: MemberId, count: usize) {
        let frame = json!({ "type": "for_you", "count": count })
            .to_string()
            .into();
        let _ = st.hub.tx.send(Event::ForYou { member, frame });
    }

    /// Makes every connection catch up with a Workspace that was replaced whole.
    pub fn broadcast_resync(st: &Shared) {
        let _ = st.hub.tx.send(Event::Resync);
    }

    /// Closes every live connection of `member`.
    pub fn disconnect_member(st: &Shared, member: MemberId) {
        let _ = st.hub.tx.send(Event::Kick { member });
    }

    /// The current `presence` frame of `branch` and the presence version.
    fn current_presence(&self, branch: BranchId) -> (Utf8Bytes, u64) {
        let p = self.presence();
        let set = p.counts.get(&branch).cloned().unwrap_or_default();
        (presence_frame(branch, &set), p.version)
    }

    /// Moves one connection of `member` from `from` to `to` (either may be `None`).
    /// Broadcasts `presence` for every Branch whose set of Members changed, and returns
    /// the current `presence` frame and version of `to`.
    fn move_member(
        &self,
        member: MemberId,
        from: Option<BranchId>,
        to: Option<BranchId>,
    ) -> Option<(Utf8Bytes, u64)> {
        let mut p = self.presence();
        let mut changed = Vec::new();
        if let Some(b) = from {
            let set = p.counts.entry(b).or_default();
            if let Some(n) = set.get_mut(&member) {
                *n -= 1;
                if *n == 0 {
                    set.remove(&member);
                    changed.push(b);
                }
            }
        }
        if let Some(b) = to {
            let n = p.counts.entry(b).or_default().entry(member).or_insert(0);
            *n += 1;
            if *n == 1 {
                if changed.contains(&b) {
                    changed.retain(|c| *c != b);
                } else {
                    changed.push(b);
                }
            }
        }
        for b in changed {
            p.version += 1;
            let version = p.version;
            let set = p.counts.get(&b).cloned().unwrap_or_default();
            if set.is_empty() {
                p.counts.remove(&b);
            }
            let frame = presence_frame(b, &set);
            let _ = self.tx.send(Event::Presence {
                branch: b,
                version,
                frame,
            });
        }
        to.map(|b| {
            let set = p.counts.get(&b).cloned().unwrap_or_default();
            (presence_frame(b, &set), p.version)
        })
    }
}

/// `GET /api/ws`: same Origin rule as writes, and a session is required.
pub async fn ws_handler(
    State(st): State<Shared>,
    headers: HeaderMap,
    who: Result<SignedIn, ApiError>,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    if !origin_allowed(&st, &headers) {
        return ApiError::ForbiddenOrigin.into_response();
    }
    let who = match who {
        Ok(who) => who,
        Err(e) => return e.into_response(),
    };
    let upgrade = match upgrade {
        Ok(u) => u,
        Err(_) => {
            return ApiError::BadRequest("Expected a WebSocket upgrade.".to_string())
                .into_response();
        }
    };
    upgrade
        .max_message_size(MAX_CLIENT_MESSAGE)
        .on_upgrade(move |socket| Connection::new(st, who).run(socket))
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ClientMessage {
    Subscribe { branch: String, after: u64 },
    Editing { card: Option<String> },
}

struct Subscription {
    branch: BranchId,
    /// The head this connection has been sent up to.
    seq: u64,
    presence_version: u64,
    editing_version: u64,
    /// The newest Suggestion list this connection may already have (from a frame, or read
    /// over HTTP after subscribing).
    suggestions_version: u64,
}

/// One WebSocket connection.
struct Connection {
    st: Shared,
    who: SignedIn,
    /// Tells this connection's soft-lock claim from any other's.
    id: u64,
    sub: Option<Subscription>,
    /// The newest To-do list this connection has been sent (after a resync, read).
    todos_version: u64,
    /// Guests only: when the last `refresh` frame was sent.
    refresh_sent: Option<Instant>,
    /// Guests only: the head a `refresh` is still owed for, once `REFRESH_EVERY` has passed
    /// since the last one.
    refresh_owed: Option<u64>,
}

/// Frames this connection wants to send, or the reason to close it.
type Outcome = Result<Vec<Utf8Bytes>, ()>;

impl Connection {
    fn new(st: Shared, who: SignedIn) -> Connection {
        let id = st.hub.next_connection.fetch_add(1, Ordering::Relaxed);
        Connection {
            st,
            who,
            id,
            sub: None,
            todos_version: 0,
            refresh_sent: None,
            refresh_owed: None,
        }
    }

    async fn run(mut self, socket: WebSocket) {
        let (mut sink, mut stream) = socket.split();
        let mut events = self.st.hub.tx.subscribe();
        let mut shutdown = self.st.shutdown.subscribe();
        let mut ping = tokio::time::interval_at(Instant::now() + PING_EVERY, PING_EVERY);
        let mut unanswered = 0u32;
        loop {
            let refresh_at = self.refresh_at();
            let outcome: Outcome = tokio::select! {
                msg = stream.next() => match msg {
                    Some(Ok(Message::Text(text))) => Ok(self.on_client_text(&text).await),
                    Some(Ok(Message::Pong(_))) => { unanswered = 0; Ok(Vec::new()) }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => Err(()),
                    Some(Ok(_)) => Ok(Vec::new()),
                },
                ev = events.recv() => match ev {
                    Ok(Event::Resync) => Ok(self.resync().await),
                    Ok(ev) => self.on_event(ev),
                    Err(RecvError::Lagged(_)) => Ok(self.resync().await),
                    Err(RecvError::Closed) => Err(()),
                },
                _ = ping.tick() => {
                    if unanswered >= MAX_UNANSWERED_PINGS || !self.still_signed_in().await {
                        Err(())
                    } else {
                        unanswered += 1;
                        match sink.send(Message::Ping(Default::default())).await {
                            Ok(()) => Ok(Vec::new()),
                            Err(_) => Err(()),
                        }
                    }
                },
                _ = tokio::time::sleep_until(refresh_at.unwrap_or_else(Instant::now)),
                    if refresh_at.is_some() => Ok(self.owed_refresh()),
                _ = shutdown.changed() => Err(()),
            };
            let Ok(frames) = outcome else { break };
            let mut failed = false;
            for frame in frames {
                if sink.send(Message::Text(frame)).await.is_err() {
                    failed = true;
                    break;
                }
            }
            if failed {
                break;
            }
        }
        // Guests were never in presence and never hold a claim.
        if let Some(sub) = self.sub.take()
            && !self.is_guest()
        {
            self.release_claim(sub.branch);
            self.st
                .hub
                .move_member(self.who.id(), Some(sub.branch), None);
        }
        let _ = sink.close().await;
    }

    fn is_guest(&self) -> bool {
        self.who.member.role == Role::Guest
    }

    /// Ends this connection's soft-lock claim on `branch`, if it has one.
    fn release_claim(&self, branch: BranchId) {
        let now = self.st.clock.now();
        self.st
            .hub
            .set_editing(self.id, self.who.id(), branch, None, now);
    }

    async fn still_signed_in(&self) -> bool {
        matches!(
            live_session(&self.st, self.who.token_hash.clone()).await,
            Ok(Some(_))
        )
    }

    /// When the owed `refresh` may go out, if one is owed.
    fn refresh_at(&self) -> Option<Instant> {
        self.refresh_owed?;
        Some(
            self.refresh_sent
                .map_or_else(Instant::now, |sent| sent + REFRESH_EVERY),
        )
    }

    /// A `refresh` for head `seq` of the subscribed Branch: now, if none went out within
    /// `REFRESH_EVERY`; otherwise it is owed, and one frame with the newest head follows
    /// when that time has passed.
    fn refresh(&mut self, seq: u64) -> Vec<Utf8Bytes> {
        let Some(branch) = self.sub.as_ref().map(|s| s.branch) else {
            return Vec::new();
        };
        let now = Instant::now();
        if self
            .refresh_sent
            .is_some_and(|sent| now < sent + REFRESH_EVERY)
        {
            self.refresh_owed = Some(self.refresh_owed.map_or(seq, |owed| owed.max(seq)));
            return Vec::new();
        }
        self.refresh_sent = Some(now);
        self.refresh_owed = None;
        vec![refresh_frame(branch, seq)]
    }

    /// The `refresh` that was held back, now that its time has come.
    fn owed_refresh(&mut self) -> Vec<Utf8Bytes> {
        let owed = self.refresh_owed.take();
        match (owed, self.sub.as_ref().map(|s| s.branch)) {
            (Some(seq), Some(branch)) => {
                self.refresh_sent = Some(Instant::now());
                vec![refresh_frame(branch, seq)]
            }
            _ => Vec::new(),
        }
    }

    /// What a Guest's connection makes of an event: new Changes on its Branch become a
    /// `refresh`; everything else is not for Guests.
    fn on_guest_event(&mut self, ev: Event) -> Outcome {
        match ev {
            Event::Kick { member } if member == self.who.id() => Err(()),
            Event::Changes { branch, seq, .. } => match &mut self.sub {
                Some(sub) if sub.branch == branch && seq > sub.seq => {
                    sub.seq = seq;
                    Ok(self.refresh(seq))
                }
                _ => Ok(Vec::new()),
            },
            Event::Kick { .. }
            | Event::Presence { .. }
            | Event::Checkpoint { .. }
            | Event::Branches { .. }
            | Event::Todos { .. }
            | Event::Editing { .. }
            | Event::Suggestions { .. }
            | Event::Comments { .. }
            | Event::ForYou { .. }
            | Event::Resync => Ok(Vec::new()),
        }
    }

    fn on_event(&mut self, ev: Event) -> Outcome {
        if self.is_guest() {
            return self.on_guest_event(ev);
        }
        match ev {
            Event::Kick { member } if member == self.who.id() => Err(()),
            Event::Kick { .. } => Ok(Vec::new()),
            Event::Checkpoint { branch, frame } => match &self.sub {
                Some(sub) if sub.branch == branch => Ok(vec![frame]),
                _ => Ok(Vec::new()),
            },
            Event::Branches { frame } => Ok(vec![frame]),
            Event::Comments { frame } => Ok(vec![frame]),
            Event::ForYou { member, frame } if member == self.who.id() => Ok(vec![frame]),
            Event::ForYou { .. } => Ok(Vec::new()),
            // Handled where events arrive, since catching up reads the Workspace.
            Event::Resync => Ok(Vec::new()),
            Event::Todos { version, frame } if version > self.todos_version => {
                self.todos_version = version;
                Ok(vec![frame])
            }
            Event::Todos { .. } => Ok(Vec::new()),
            Event::Suggestions {
                branch,
                version,
                frame,
            } => match &mut self.sub {
                Some(sub) if sub.branch == branch && version > sub.suggestions_version => {
                    sub.suggestions_version = version;
                    Ok(vec![frame])
                }
                _ => Ok(Vec::new()),
            },
            Event::Editing {
                branch,
                version,
                frame,
            } => match &mut self.sub {
                Some(sub) if sub.branch == branch && version > sub.editing_version => {
                    sub.editing_version = version;
                    Ok(vec![frame])
                }
                _ => Ok(Vec::new()),
            },
            Event::Changes { branch, seq, frame } => match &mut self.sub {
                Some(sub) if sub.branch == branch && seq > sub.seq => {
                    sub.seq = seq;
                    Ok(vec![frame])
                }
                _ => Ok(Vec::new()),
            },
            Event::Presence {
                branch,
                version,
                frame,
            } => match &mut self.sub {
                Some(sub) if sub.branch == branch && version > sub.presence_version => {
                    sub.presence_version = version;
                    Ok(vec![frame])
                }
                _ => Ok(Vec::new()),
            },
        }
    }

    async fn on_client_text(&mut self, text: &str) -> Vec<Utf8Bytes> {
        match serde_json::from_str::<ClientMessage>(text) {
            Ok(ClientMessage::Subscribe { branch, after }) => self.subscribe(&branch, after).await,
            Ok(ClientMessage::Editing { card }) => self.editing(card.as_deref()),
            Err(_) => vec![error_frame(
                "bad_request",
                "Expected {\"type\":\"subscribe\",\"branch\":…,\"after\":…} or {\"type\":\"editing\",\"card\":…}.",
            )],
        }
    }

    /// Claims the Page of `card` on the subscribed Branch, or ends the claim (`None`).
    /// Ignored from Guests and before `subscribe`. The `editing` frame, if the holders
    /// changed, comes back through the Hub like everyone else's.
    fn editing(&mut self, card: Option<&str>) -> Vec<Utf8Bytes> {
        let Some(branch) = self.sub.as_ref().map(|s| s.branch) else {
            return Vec::new();
        };
        if self.is_guest() {
            return Vec::new();
        }
        // A moved Workspace takes no claim to edit, as it takes no change.
        if card.is_some() && crate::local::is_read_only(&self.st) {
            return vec![error_frame("moved", crate::local::MOVED_SENTENCE)];
        }
        let card = match card.map(Uuid::parse_str) {
            None => None,
            Some(Ok(id)) => Some(id),
            Some(Err(_)) => {
                return vec![error_frame(
                    "bad_request",
                    "`card` must be a Card id or null.",
                )];
            }
        };
        let now = self.st.clock.now();
        self.st
            .hub
            .set_editing(self.id, self.who.id(), branch, card, now);
        Vec::new()
    }

    /// `subscribed`, then the catch-up `changes` (if any), then `presence`, then `editing`.
    /// A Guest gets `subscribed` and, if `after` is not the head, one `refresh`.
    async fn subscribe(&mut self, raw_branch: &str, after: u64) -> Vec<Utf8Bytes> {
        let (branch, seq, catch_up) = {
            let ws = self.st.workspace.read().await;
            let found = Uuid::parse_str(raw_branch)
                .ok()
                .and_then(|id| ws.branch(BranchId(id)));
            let guest = self.is_guest();
            let b = match found {
                Some(b) if may_read(&self.who, b) => b,
                _ if guest => {
                    return vec![error_frame(
                        "forbidden",
                        "Guests can read only the main Branch.",
                    )];
                }
                _ => return vec![error_frame("not_found", "There is no such Branch.")],
            };
            let seq = b.changes().len() as u64;
            let catch_up = changes_after(b, after)
                .filter(|c| !guest && !c.is_empty())
                .map(|c| changes_frame(b.id(), seq, c));
            (b.id(), seq, catch_up)
        };
        let mut frames = vec![
            json!({ "type": "subscribed", "branch": branch, "seq": seq })
                .to_string()
                .into(),
        ];
        if self.is_guest() {
            self.sub = Some(Subscription {
                branch,
                seq,
                presence_version: 0,
                editing_version: 0,
                suggestions_version: 0,
            });
            if after != seq {
                frames.extend(self.refresh(seq));
            }
            return frames;
        }
        frames.extend(catch_up);
        let old = self.sub.as_ref().map(|s| s.branch);
        let (presence, version) = self
            .st
            .hub
            .move_member(self.who.id(), old, Some(branch))
            .unwrap_or_else(|| (presence_frame(branch, &BTreeMap::new()), 0));
        frames.push(presence);
        // Leaving a Branch ends the claim made on it; subscribing again to the same one
        // keeps it.
        if let Some(old) = old
            && old != branch
        {
            self.release_claim(old);
        }
        let (editing, editing_version) = self.st.hub.current_editing(branch);
        frames.push(editing);
        self.sub = Some(Subscription {
            branch,
            seq,
            presence_version: version,
            editing_version,
            suggestions_version: self.st.hub.suggestions_version.load(Ordering::SeqCst),
        });
        frames
    }

    /// After missing broadcast frames: send the Branch list (a `branches` frame may have
    /// been among them), then what was missed as one `changes` frame, then the current
    /// `presence` and `editing`, then the To-do list and the Suggestions of the subscribed
    /// Branch. Missed `checkpoint` frames are not replayed.
    ///
    /// A Guest gets one `refresh` if its Branch moved on, and nothing else.
    async fn resync(&mut self) -> Vec<Utf8Bytes> {
        if self.is_guest() {
            let head = {
                let ws = self.st.workspace.read().await;
                self.sub
                    .as_ref()
                    .and_then(|sub| ws.branch(sub.branch))
                    .map(|b| b.changes().len() as u64)
            };
            return match (head, &mut self.sub) {
                (Some(head), Some(sub)) if head > sub.seq => {
                    sub.seq = head;
                    self.refresh(head)
                }
                _ => Vec::new(),
            };
        }
        let mut frames = Vec::new();
        {
            let ws = self.st.workspace.read().await;
            let list: Vec<BranchInfo> = ws.branches().map(|b| BranchInfo::of(&ws, b)).collect();
            frames.push(branches_frame(&list));
            if let Some(sub) = &mut self.sub
                && let Some(b) = ws.branch(sub.branch)
            {
                let head = b.changes().len() as u64;
                if let Some(missed) = changes_after(b, sub.seq).filter(|m| !m.is_empty()) {
                    frames.push(changes_frame(sub.branch, head, missed));
                    sub.seq = head;
                }
            }
        }
        if let Some(sub) = &mut self.sub {
            let (presence, version) = self.st.hub.current_presence(sub.branch);
            sub.presence_version = version;
            frames.push(presence);
            let (editing, version) = self.st.hub.current_editing(sub.branch);
            sub.editing_version = version;
            frames.push(editing);
        }
        {
            // Under the order lock, so a list older than a frame already sent cannot
            // follow it.
            let _order = self.st.hub.todo_order.lock().await;
            if let Ok(todos) = crate::app::blocking(&self.st, |s| s.todos()).await {
                self.todos_version = self.st.hub.todos_version.load(Ordering::SeqCst);
                frames.push(todos_frame(&todos));
            }
        }
        if let Some(branch) = self.sub.as_ref().map(|s| s.branch) {
            let _order = self.st.hub.suggestion_order.lock().await;
            if let Ok(list) = crate::suggestions::listed(&self.st, branch).await {
                let version = self.st.hub.suggestions_version.load(Ordering::SeqCst);
                if let Some(sub) = &mut self.sub {
                    sub.suggestions_version = version;
                }
                frames.push(suggestions_frame(branch, &list));
            }
        }
        frames
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use qoop_core::{EntityId, EntityKind, Fields, Op, Value as FieldValue, Workspace};
    use tokio::sync::{RwLock, Semaphore, watch};

    use super::*;
    use crate::Clock;
    use crate::app::AppState;
    use crate::auth::Throttle;
    use crate::config::Config;
    use crate::store::{MemberRecord, MemoryStore};
    use crate::tokens::RateLimit;

    fn state() -> (Shared, BranchId) {
        let (workspace, main) = Workspace::new();
        let st = Arc::new(AppState {
            config: Config::for_tests("."),
            store: Arc::new(MemoryStore::new()),
            workspace: RwLock::new(workspace),
            hub: Hub::default(),
            throttle: Throttle::default(),
            tool_rate: RateLimit::default(),
            lookup_rate: RateLimit::default(),
            ai: crate::ai::AiState::new().unwrap(),
            clock: Clock::manual(0),
            hashing: Semaphore::new(1),
            dummy_hash: String::new(),
            shutdown: Arc::new(watch::Sender::new(false)),
            local: None,
        });
        (st, main)
    }

    fn connection(st: &Shared, role: Role) -> Connection {
        let member = MemberRecord {
            id: MemberId::new(),
            email: Some(format!("{}@example.org", role.as_str())),
            name: role.as_str().to_string(),
            role,
            color: String::new(),
            password_hash: String::new(),
            access_until: (role == Role::Guest).then_some(i64::MAX),
            created_at: 0,
        };
        Connection::new(
            st.clone(),
            SignedIn {
                member,
                token_hash: String::new(),
            },
        )
    }

    /// Adds one Card to `branch`; returns the new head.
    async fn change(st: &Shared, branch: BranchId) -> u64 {
        let mut fields = Fields::new();
        fields.insert("title".into(), FieldValue::Text("A".into()));
        let op = Op::Create {
            entity: EntityId(Uuid::new_v4()),
            kind: EntityKind::Card,
            fields,
        };
        let mut ws = st.workspace.write().await;
        ws.record_all(branch, MemberId::new(), 0, vec![op])
            .unwrap()
            .seq
    }

    fn kinds(frames: &[Utf8Bytes]) -> Vec<String> {
        frames
            .iter()
            .map(|f| {
                let v: serde_json::Value = serde_json::from_str(f.as_str()).unwrap();
                v["type"].as_str().unwrap().to_string()
            })
            .collect()
    }

    /// One event of every kind there is, all about `branch`, all newer than anything a
    /// connection has seen; `seq` is what the `changes` one claims as the head.
    fn every_event(branch: BranchId, seq: u64) -> Vec<Event> {
        let frame = || Utf8Bytes::from(r#"{"type":"secret"}"#);
        vec![
            Event::Changes {
                branch,
                seq,
                frame: frame(),
            },
            Event::Presence {
                branch,
                version: u64::MAX,
                frame: frame(),
            },
            Event::Checkpoint {
                branch,
                frame: frame(),
            },
            Event::Branches { frame: frame() },
            Event::Todos {
                version: u64::MAX,
                frame: frame(),
            },
            Event::Editing {
                branch,
                version: u64::MAX,
                frame: frame(),
            },
            Event::Suggestions {
                branch,
                version: u64::MAX,
                frame: frame(),
            },
            Event::Kick {
                member: MemberId::new(),
            },
            Event::Comments { frame: frame() },
            Event::ForYou {
                member: MemberId::new(),
                frame: frame(),
            },
            Event::Resync,
        ]
    }

    #[tokio::test]
    async fn no_event_but_new_changes_gives_a_guest_a_frame_and_that_one_is_a_refresh() {
        let (st, main) = state();
        let mut guest = connection(&st, Role::Guest);
        // Before subscribing: nothing at all.
        for ev in every_event(main, 5) {
            assert_eq!(guest.on_event(ev), Ok(Vec::new()));
        }
        let frames = guest.subscribe(&main.0.to_string(), 0).await;
        assert_eq!(kinds(&frames), ["subscribed"]);
        // Subscribed: the frame that was broadcast is never forwarded, whatever it is.
        let mut sent = Vec::new();
        for ev in every_event(main, 5) {
            sent.extend(guest.on_event(ev).unwrap());
        }
        assert_eq!(
            sent,
            vec![refresh_frame(main, 5)],
            "one refresh, built here, and nothing that was broadcast"
        );
        // Changes it already knows of, and those of another Branch, are not news.
        for ev in [
            Event::Changes {
                branch: main,
                seq: 5,
                frame: "x".into(),
            },
            Event::Changes {
                branch: BranchId(Uuid::new_v4()),
                seq: 99,
                frame: "x".into(),
            },
        ] {
            assert_eq!(guest.on_event(ev), Ok(Vec::new()));
        }
        assert_eq!(guest.refresh_owed, None);
        // Being removed still closes the connection.
        let me = guest.who.id();
        assert_eq!(guest.on_event(Event::Kick { member: me }), Err(()));
    }

    #[tokio::test]
    async fn refreshes_within_the_window_are_held_back_as_one_with_the_newest_head() {
        let (st, main) = state();
        let mut guest = connection(&st, Role::Guest);
        guest.subscribe(&main.0.to_string(), 0).await;
        assert_eq!(guest.refresh_at(), None);
        let changes = |seq| Event::Changes {
            branch: main,
            seq,
            frame: "x".into(),
        };
        assert_eq!(guest.on_event(changes(1)), Ok(vec![refresh_frame(main, 1)]));
        let sent = guest.refresh_sent.unwrap();
        for seq in 2..=4 {
            assert_eq!(guest.on_event(changes(seq)), Ok(Vec::new()));
        }
        assert_eq!(guest.refresh_owed, Some(4));
        assert_eq!(guest.refresh_at(), Some(sent + REFRESH_EVERY));
        assert_eq!(guest.owed_refresh(), vec![refresh_frame(main, 4)]);
        assert_eq!(guest.refresh_owed, None);
        assert_eq!(guest.refresh_at(), None);
        assert_eq!(guest.owed_refresh(), Vec::<Utf8Bytes>::new());
    }

    #[tokio::test]
    async fn a_guest_is_not_in_presence_and_gets_one_refresh_when_behind() {
        let (st, main) = state();
        let head = change(&st, main).await;
        let mut guest = connection(&st, Role::Guest);
        let frames = guest.subscribe(&main.0.to_string(), 0).await;
        assert_eq!(kinds(&frames), ["subscribed", "refresh"]);
        assert_eq!(frames[1], refresh_frame(main, head));
        assert!(st.hub.presence().counts.is_empty());
        assert_eq!(st.hub.presence().version, 0);

        let mut member = connection(&st, Role::Member);
        let frames = member.subscribe(&main.0.to_string(), 0).await;
        assert_eq!(
            kinds(&frames),
            ["subscribed", "changes", "presence", "editing"]
        );
        let (presence, _) = st.hub.current_presence(main);
        assert_eq!(
            presence,
            presence_frame(main, &BTreeMap::from([(member.who.id(), 1)]))
        );
    }

    #[tokio::test]
    async fn a_lagged_guest_is_resynced_with_one_refresh_and_a_member_with_everything() {
        let (st, main) = state();
        let mut guest = connection(&st, Role::Guest);
        let mut member = connection(&st, Role::Member);
        guest.subscribe(&main.0.to_string(), 0).await;
        member.subscribe(&main.0.to_string(), 0).await;
        let mut idle_guest = connection(&st, Role::Guest);

        // More is broadcast than a connection's queue holds, so the oldest is lost.
        let mut events = st.hub.tx.subscribe();
        let head = change(&st, main).await;
        for _ in 0..CHANNEL_CAPACITY {
            for ev in every_event(main, head) {
                let _ = st.hub.tx.send(ev);
            }
        }
        assert!(matches!(events.recv().await, Err(RecvError::Lagged(_))));

        // What the connection loop does then: resync, and carry on with what is left.
        let mut to_guest = guest.resync().await;
        let mut to_idle = idle_guest.resync().await;
        let to_member = member.resync().await;
        while let Ok(ev) = events.try_recv() {
            to_guest.extend(guest.on_event(ev.clone()).unwrap());
            to_idle.extend(idle_guest.on_event(ev).unwrap());
        }
        assert_eq!(to_guest, vec![refresh_frame(main, head)]);
        assert_eq!(guest.refresh_owed, None);
        assert_eq!(to_idle, Vec::<Utf8Bytes>::new());
        // Up to date again: another resync has nothing to say.
        assert_eq!(guest.resync().await, Vec::<Utf8Bytes>::new());

        assert_eq!(
            kinds(&to_member),
            [
                "branches",
                "changes",
                "presence",
                "editing",
                "todos",
                "suggestions"
            ]
        );

        // A resync inside the window is held back like any other refresh.
        let head = change(&st, main).await;
        assert_eq!(guest.resync().await, Vec::<Utf8Bytes>::new());
        assert_eq!(guest.refresh_owed, Some(head));
        assert_eq!(guest.owed_refresh(), vec![refresh_frame(main, head)]);
    }
}
