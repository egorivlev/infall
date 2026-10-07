//! Live updates over WebSocket (contract §7): subscriptions, broadcast and presence; and
//! who is editing a Page (contract §11), which lives only here.

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
use uuid::Uuid;

use crate::app::Shared;
use crate::auth::{SignedIn, live_session, origin_allowed};
use crate::boards::{BranchInfo, changes_after, may_read};
use crate::error::ApiError;
use crate::store::{Role, TodoRecord};

const PING_EVERY: Duration = Duration::from_secs(30);
const MAX_UNANSWERED_PINGS: u32 = 2;
const MAX_CLIENT_MESSAGE: usize = 64 * 1024;
const CHANNEL_CAPACITY: usize = 1024;

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
    /// The Member's account is gone: close their connections.
    Kick { member: MemberId },
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
        }
    }

    async fn run(mut self, socket: WebSocket) {
        let (mut sink, mut stream) = socket.split();
        let mut events = self.st.hub.tx.subscribe();
        let mut shutdown = self.st.shutdown.subscribe();
        let mut ping =
            tokio::time::interval_at(tokio::time::Instant::now() + PING_EVERY, PING_EVERY);
        let mut unanswered = 0u32;
        loop {
            let outcome: Outcome = tokio::select! {
                msg = stream.next() => match msg {
                    Some(Ok(Message::Text(text))) => Ok(self.on_client_text(&text).await),
                    Some(Ok(Message::Pong(_))) => { unanswered = 0; Ok(Vec::new()) }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => Err(()),
                    Some(Ok(_)) => Ok(Vec::new()),
                },
                ev = events.recv() => match ev {
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
        if let Some(sub) = self.sub.take() {
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

    fn on_event(&mut self, ev: Event) -> Outcome {
        match ev {
            Event::Kick { member } if member == self.who.id() => Err(()),
            Event::Kick { .. } => Ok(Vec::new()),
            Event::Checkpoint { branch, frame } => match &self.sub {
                Some(sub) if sub.branch == branch && !self.is_guest() => Ok(vec![frame]),
                _ => Ok(Vec::new()),
            },
            Event::Branches { frame } if !self.is_guest() => Ok(vec![frame]),
            Event::Branches { .. } => Ok(Vec::new()),
            Event::Todos { version, frame } if !self.is_guest() && version > self.todos_version => {
                self.todos_version = version;
                Ok(vec![frame])
            }
            Event::Todos { .. } => Ok(Vec::new()),
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
                .filter(|c| !c.is_empty())
                .map(|c| changes_frame(b.id(), seq, c));
            (b.id(), seq, catch_up)
        };
        let mut frames = vec![
            json!({ "type": "subscribed", "branch": branch, "seq": seq })
                .to_string()
                .into(),
        ];
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
        });
        frames
    }

    /// After missing broadcast frames: send the Branch list and the To-do list (a `branches`
    /// or `todos` frame may have been among them; never to Guests), then what was missed as
    /// one `changes` frame, then the current `presence` and `editing`. Missed `checkpoint`
    /// frames are not replayed.
    async fn resync(&mut self) -> Vec<Utf8Bytes> {
        let mut frames = Vec::new();
        let guest = self.is_guest();
        {
            let ws = self.st.workspace.read().await;
            if !guest {
                let list: Vec<BranchInfo> = ws.branches().map(|b| BranchInfo::of(&ws, b)).collect();
                frames.push(branches_frame(&list));
            }
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
        if !guest {
            // Under the order lock, so a list older than a frame already sent cannot
            // follow it.
            let _order = self.st.hub.todo_order.lock().await;
            if let Ok(todos) = crate::app::blocking(&self.st, |s| s.todos()).await {
                self.todos_version = self.st.hub.todos_version.load(Ordering::SeqCst);
                frames.push(todos_frame(&todos));
            }
        }
        frames
    }
}
