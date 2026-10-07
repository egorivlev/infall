# Qoop — server API contract (M1–M6)

The contract between `crates/server` and `web/`. Both are built against this file; where they disagree with it, this file wins. Vocabulary: [CONTEXT.md](../../CONTEXT.md). Versioning rules: [core.md](core.md).

M1 scope: accounts, one Branch in use (`main`), the Board (Cards, Frames, Connections), live updates. No Branch switching, History, Merge, Pages, To-dos or AI yet — but nothing here may make those harder.

## 1. Process and configuration

Binary `qoop-server` (crate `crates/server`). Subcommands:

- `serve` (default) — run the HTTP server.
- `create-admin --email <e> --name <n>` — create the first Admin. Password is read from the env var `QOOP_ADMIN_PASSWORD` if set, otherwise prompted on the terminal without echo. Refuses if that email exists.
- `reset-password --email <e>` — set a new password for an existing account (same password input as above) and delete all of that account's sessions. The only way back in if an Admin forgets theirs; it needs shell access to the machine, which is the point.

`serve` shuts down gracefully on SIGTERM and SIGINT: it stops accepting connections, lets in-flight requests finish (so a database write is never cut off), and exits within a few seconds.

Environment:

| Variable | Default | Meaning |
|---|---|---|
| `QOOP_ADDR` | `127.0.0.1:8787` | listen address |
| `QOOP_DB` | `./qoop.db` | SQLite file |
| `QOOP_PUBLIC_ORIGIN` | `http://localhost:8787` | the origin people use; drives the cookie `Secure` flag (set when it starts with `https://`), the Origin check, and invite URLs |
| `QOOP_DEV_ORIGIN` | unset | one extra allowed Origin (e.g. `http://localhost:5173`) for local UI development |
| `QOOP_WEB_DIR` | `./web/dist` | built UI to serve; any non-`/api` path that is not a file serves `index.html` |

## 2. Storage

SQLite (`rusqlite`, bundled). Tables: `members`, `sessions`, `invites`, and `workspace` — a single row holding the whole core `Workspace` as JSON, rewritten inside a transaction on every successful mutation before the response is sent. The `Workspace` lives in memory behind one lock; the database is read once at start. The database runs in WAL mode with `synchronous=FULL`; the schema is created on first start and its version kept in `PRAGMA user_version`, so a newer binary can migrate an older file in place. (Whole-snapshot storage is an M1 simplification; it sits behind a small storage trait so it can be replaced.)

## 3. People and sessions

```ts
type Role = "admin" | "member" | "guest";
type Member = {
  id: string;            // uuid; this is the core MemberId used as Change.author
  name: string;
  role: Role;
  color: string;         // CSS colour assigned at creation from a fixed palette
  email?: string;        // present only for yourself, or when the caller is an Admin
  access_until?: number; // unix ms; guests only
};
```

- Passwords: Argon2id, minimum 12 characters. Never logged, never returned.
- Session: 32 random bytes, sent as cookie `qoop_session` (`HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when the public origin is https, 30-day expiry, sliding). Only a hash of the token is stored.
- Every request whose method is not `GET`/`HEAD` must carry header `X-Qoop-Request: 1` and an `Origin` equal to the public origin or the dev origin; otherwise `403 forbidden_origin`. The WebSocket upgrade checks `Origin` the same way.
- Login failures: more than 5 for one email within 15 minutes → `429 too_many_attempts` until the window passes. The login error never says whether the email exists.
- A Guest whose `access_until` has passed is treated as signed out.
- There is no open sign-up. Accounts come only from `create-admin` or an invite.

## 4. Errors

Every error response is JSON:

```json
{ "error": { "code": "snake_case_code", "message": "Human sentence.", "detail": null } }
```

| Status | Codes |
|---|---|
| 400 | `bad_request` |
| 401 | `not_signed_in`, `bad_credentials` |
| 403 | `forbidden`, `forbidden_origin` |
| 404 | `not_found` |
| 409 | `rejected` (an operation the core refused; `detail` is the core `ApplyError` as JSON), `email_taken` |
| 410 | `invite_expired` |
| 429 | `too_many_attempts` |
| 500 | `internal` (no internals in the message) |

## 5. Wire shapes from the core

These are exactly the core's `serde` output. Ids are uuid strings.

```ts
type Value = "Null" | { Float: number } | { Text: string } | { Ref: string };
type Kind = "Card" | "Frame" | "Connection";
type Fields = Record<string, Value>;
type Op =
  | { Create: { entity: string; kind: Kind; fields: Fields } }
  | { Set: { entity: string; field: string; value: Value } }
  | { Delete: { entity: string } }
  | { Undelete: { entity: string } };
type Origin = "Edit" | { Restore: { batch: string; to_seq: number } } | { Merge: { batch: string; source: Moment } };
type Moment = { branch: string; seq: number };
type Change = { id: string; author: string; at: number; op: Op; origin: Origin };
type Entity = { kind: Kind; fields: Fields; deleted: boolean };
```

Fields per kind (see core.md §1): Card `title`, `summary`, `status` (`idea` | `reading` | `understood` | `open_question` | `dead_end`), `x`, `y`, `w`, `h`; Frame `title`, `x`, `y`, `w`, `h`; Connection `from`, `to`, `label`, `kind` (`related` | `directed` | `contradicts`). A field set to `"Null"` is removed. Entity ids are generated by the client (uuid v4).

## 6. HTTP endpoints

All under `/api`. All require a session except where marked *public*.

### Health
`GET /api/health` *public* → `200 { "ok": true }` once the database has been opened. Reveals nothing else.

### Auth
| Method, path | Body | 200 response |
|---|---|---|
| `POST /api/auth/login` *public* | `{ email, password }` | `{ member: Member }` + cookie |
| `POST /api/auth/logout` | — | `{}` and clears the cookie |
| `GET /api/me` | — | `{ member: Member }` |
| `GET /api/invites/lookup?token=…` *public* | — | `{ email, role }`; `404` unknown, `410` expired or used |
| `POST /api/auth/accept-invite` *public* | `{ token, name, password }` | `{ member: Member }` + cookie; the invite is consumed |

### People (reading: any Member or Admin; changing: Admin only; Guests get `403`)
| Method, path | Body | 200 response |
|---|---|---|
| `GET /api/members` | — | `{ members: Member[] }` |
| `DELETE /api/members/{id}` | — | `{}`; removes the account and its sessions; an Admin cannot remove themself. Their past Changes keep their author id |
| `GET /api/invites` | — | `{ invites: Invite[] }` (pending only) |
| `POST /api/invites` | `{ email, role: "member" \| "guest", access_until?: number }` | `{ invite: Invite, url: string }` — `url` is `<public origin>/invite/<token>`; the token is shown only here. `access_until` is required for guests |
| `DELETE /api/invites/{id}` | — | `{}` |

```ts
type Invite = { id: string; email: string; role: Role; access_until?: number; expires_at: number; created_by: string };
```
Invites expire after 7 days and work once. Only a hash of the token is stored.

### Branches and the Board
| Method, path | Body | 200 response |
|---|---|---|
| `GET /api/branches` | — | `{ branches: BranchInfo[] }` |
| `GET /api/branches/{id}/board` | — | `{ branch: string, seq: number, entities: Record<string, Entity> }` — the Board at the head, including deleted entities |
| `GET /api/branches/{id}/changes?after={seq}` | — | `{ seq: number, changes: Change[] }` — the Changes with index ≥ `after`, in order; `seq` is the head |
| `POST /api/branches/{id}/ops` | `{ ops: Op[] }` (1–200) | `{ seq: number, changes: Change[] }` — all applied as one all-or-nothing batch authored by the caller, `origin: "Edit"`; `seq` is the new head. `409 rejected` if the core refuses any op, and then none is applied |

```ts
type BranchInfo = { id: string; name: string; seq: number; parent?: Moment; created_by?: string; created_at?: number };
```
Guests may read only the Branch named `main` and may not `POST` ops (`403 forbidden`).

## 7. WebSocket — live updates

`GET /api/ws` (session cookie + Origin check). JSON text frames.

Client → server:
```ts
{ type: "subscribe", branch: string, after: number }   // one Branch at a time; a new subscribe replaces the old
```

Server → client:
```ts
{ type: "subscribed", branch: string, seq: number }
{ type: "changes", branch: string, seq: number, changes: Change[] }  // `seq` is the head AFTER these changes
{ type: "presence", branch: string, members: string[] }              // ids connected to this Branch, sorted
{ type: "error", code: string, message: string }
```

- After `subscribe`, the server sends `subscribed`, then one `changes` frame with everything after `after` if there is any, then `presence`.
- Every successful `POST …/ops` is broadcast to every subscriber of that Branch **including the sender**, in order. A client applies a `changes` frame only when `seq - changes.length` equals its own seq; otherwise it refetches the Board.
- `presence` is re-sent to a Branch's subscribers whenever its set changes. A Member connected twice appears once.
- The server pings every 30 s and drops a connection that misses two.

## 8. Responses and headers

`Content-Type: application/json` for API responses. For every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, and for HTML `Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'`. Request bodies over 1 MB are refused.

## 9. M2 — History, Checkpoints, Restore, Branches

Everything in this section is for Members and Admins only; a Guest gets `403 forbidden` (a Guest has no history and no other Branches). The one M1 exception stays: a Guest may still `GET …/changes` on `main`, because the live-update catch-up uses it.

```ts
type Checkpoint = { name: string; moment: Moment; author: string; at: number };
```

`BranchInfo` gains `checkpoints: number` (how many Checkpoints the Branch has).

| Method, path | Body | 200 response |
|---|---|---|
| `GET /api/branches/{id}/board?at={seq}` | — | same shape as the Board response, but at the moment `seq` (0 = the Branch as it was when created; for a forked Branch that is its parent's Board at the fork moment). `seq` in the response is the requested one. `400 bad_request` if `at` is past the head. Without `at`: the head, as in M1 (Guests allowed on `main` only without `at`) |
| `GET /api/branches/{id}/checkpoints` | — | `{ checkpoints: Checkpoint[] }` ordered by moment, then name |
| `POST /api/branches/{id}/checkpoints` | `{ name: string, seq?: number }` | `{ checkpoint: Checkpoint }` — names the moment `seq` (default: the head). `400 bad_request` for an empty name (after trimming), a name over 80 characters, or a `seq` past the head; `409 name_taken` if the Branch already has a Checkpoint with that name |
| `POST /api/branches/{id}/restore` | `{ to_seq: number }` | `{ seq: number, changes: Change[] }` — appends the Changes that return the Branch to its Board at `to_seq` (core `restore`), authored by the caller, `origin: Restore`. `changes` may be empty when the Board already matches. `400 bad_request` if `to_seq` is past the head |
| `POST /api/branches` | `{ name: string, from: Moment }` | `{ branch: BranchInfo }` — forks a new Branch from that moment. `400 bad_request` for an empty name, a name over 60 characters, or a moment that does not exist; `409 name_taken` |

New error code: `409 name_taken`.

All of these persist before responding, exactly like `POST …/ops`, and hold the same write lock so order on disk, in memory and on the wire agree.

WebSocket additions (server → client):

```ts
{ type: "checkpoint", branch: string, checkpoint: Checkpoint }  // to subscribers of that Branch, sender included
{ type: "branches", branches: BranchInfo[] }                    // the full list, to every connected Member/Admin (never Guests), whenever a Branch is created
```

A Restore is broadcast as an ordinary `changes` frame (only when it produced Changes). Clients that do not know the new frame types must ignore them.

There is no deleting or renaming of Checkpoints or Branches in M2: history is append-only.

## 10. M3 — Merge

Members and Admins only (`403 forbidden` for Guests). Shapes are the core's `serde` output (core.md §5):

```ts
type Side = "Source" | "Target";
type ConflictKey = { entity: string; field: string | null };   // field null = edit vs delete
type Conflict =
  | { Field: { entity: string; field: string; base: Value; source: Value; target: Value } }
  | { EditVsDelete: { entity: string; deleted_on: Side } };
type Decision = "TakeSource" | "TakeTarget" | { Custom: Value };
type Decisions = [ConflictKey, Decision][];
type MergePlan = { source: Moment; target: Moment; base: Moment; auto: Op[]; conflicts: Conflict[] };
```

| Method, path | Body | 200 response |
|---|---|---|
| `GET /api/merges/plan?source={branchId}&target={branchId}` | — | `{ plan: MergePlan }` — what merging `source` into `target` would do right now. Changes nothing. `404 not_found` for an unknown Branch; `400 not_parent_and_child` unless one is the other's direct parent |
| `POST /api/merges` | `{ plan: MergePlan, decisions: Decisions, checkpoint?: string }` | `{ seq: number, changes: Change[], checkpoint?: Checkpoint }` — applies the Merge on the target as one batch authored by the caller (`origin: Merge`); `seq` is the target's new head; `changes` may be empty. With `checkpoint`, a Checkpoint of that name (same rules as §9: trimmed, 1–80 characters, no control characters) is placed on the target at the moment just before the Merge |

Errors of `POST /api/merges` — on any of them nothing is changed:

| Status, code | When | `detail` |
|---|---|---|
| `409 stale` | a Branch changed since the plan was made, or the plan does not match what the Branches give now — plan again | null |
| `400 undecided` | Conflicts without a Decision | `ConflictKey[]` |
| `400 bad_decision` | a Decision for no Conflict, a repeated one, or `Custom` on edit vs delete | the `ConflictKey` |
| `400 not_parent_and_child` | | null |
| `409 name_taken` | the Checkpoint name is used on the target | null |
| `409 rejected` | a decided value the core refuses (e.g. a Connection left without an endpoint, a wrong value type) | the core `ApplyError` |
| `404 not_found` | a Branch in the plan does not exist | null |

The plan is not trusted: the server recomputes it under the write lock (the core does) and refuses with `stale` on any difference. Persist, then broadcast: the Merge's Changes as an ordinary `changes` frame to the target's subscribers (only if there are any), the `checkpoint` frame if one was made, and the `branches` frame to all Members/Admins (so lists show the new head).

## 11. M4 — Pages, Sources, To-dos

### Pages and Sources
Research Content, so they are ordinary entities sent through `POST /api/branches/{id}/ops` and returned by the Board endpoints (core.md §1): `Kind` gains `"Block" | "Source" | "Attachment"`. Nothing new on the server for them. Sizes: a single Text value may be at most 100 000 characters (`400 bad_request` otherwise) — this applies to every Text field of every kind, and to hand-written values in `POST /api/merges`.

### Who is editing a Page (soft lock)
Not stored, not versioned; lives only in the live connection.

Client → server: `{ type: "editing", card: string | null }` — "I am editing the Page of this Card on the Branch I am subscribed to" (null = stopped). Ignored from Guests and before `subscribe`.

Server → client, to every subscriber of that Branch (Guests included), after `subscribed` and whenever it changes:
```ts
{ type: "editing", branch: string, editors: { card: string; member: string; since: number }[] }  // one entry per Card: whoever claimed it first and still holds it
```
A claim ends when that connection sends another `editing`, subscribes to another Branch, or closes; the next claimant in arrival order (if any) then becomes the holder. One connection holds at most one Card. The server does not refuse ops from non-holders — the lock is advisory, enforced by the UI.

### To-dos
Outside versioning: the same on every Branch, stored in their own table. Members and Admins only (`403 forbidden` for Guests).

```ts
type Todo = {
  id: string;
  owner: string;            // Member id — whose To-do it is
  text: string;             // 1–500 characters after trimming, no control characters
  done: boolean;
  done_at?: number;
  created_by: string;       // who added it (owner, or someone assigning)
  created_at: number;
  card?: { id: string; title: string; branch: string };  // optional pointer: entity id, the title when it was set, and the Branch id it was set on. Not validated against the Board, and kept if the Card is removed
};
```

| Method, path | Body | 200 response |
|---|---|---|
| `GET /api/todos` | — | `{ todos: Todo[] }` ordered by `created_at`, then id |
| `POST /api/todos` | `{ owner: string, text: string, card?: {id, title, branch} }` | `{ todo: Todo }`. Any Member may add to any Member's list (`owner` must be an existing Member or Admin, not a Guest: `400 bad_request`) |
| `PATCH /api/todos/{id}` | any of `{ text, done, card }` (`card: null` clears) | `{ todo: Todo }`. `done` may be changed only by the owner (`403 forbidden`); `text`/`card` by the owner or the creator |
| `DELETE /api/todos/{id}` | — | `{}`; owner or creator only |

Removing a Member (`DELETE /api/members/{id}`) deletes the To-dos they own; ones they created for others stay.

After every change the server sends `{ type: "todos", todos: Todo[] }` (the full list) to every connected Member/Admin, never to Guests.

## 12. M5 — AI tool layer, access tokens, Suggestions

See [ADR 0003](../adr/0003-ai-through-members-claude-subscriptions.md). The server holds no model and no model key. An AI reaches Qoop through the tool endpoint with a Member's access token, can read what that Member can read, and can write exactly one thing: Suggestions. Nothing an AI sends becomes Research Content until a Member accepts it.

### Access tokens
For Members and Admins (Guests `403`). A token acts as its Member **only** on `/mcp`; it is never accepted on `/api/*`, and a session cookie is never accepted on `/mcp`.

```ts
type AccessToken = { id: string; name: string; created_at: number; last_used_at?: number };
```

| Method, path | Body | 200 response |
|---|---|---|
| `GET /api/tokens` | — | `{ tokens: AccessToken[] }` — the caller's own, oldest first |
| `POST /api/tokens` | `{ name: string }` (1–60 characters, trimmed, no control characters) | `{ token: AccessToken, secret: string }` — `secret` is `qoop_pat_` + 43 url-safe base64 characters (32 random bytes); shown only here. Only its SHA-256 is stored. At most 10 per Member (`400 bad_request` beyond) |
| `DELETE /api/tokens/{id}` | — | `{}`; own tokens only (`404` otherwise) |

Removing a Member and `reset-password` delete that Member's tokens. `last_used_at` is updated at most once a minute.

### Suggestions
Not Research Content, not versioned; each belongs to one Branch. Members and Admins only.

```ts
type Suggestion = {
  id: string;
  branch: string;                       // Branch id
  kind: "source" | "connection";
  card?: string;                        // kind source: the Card to attach to
  source?: { url?: string; doi?: string; title?: string; authors?: string; year?: string };
  connection?: { from: string; to: string; kind: "related" | "directed" | "contradicts"; label?: string };
  reason: string;                       // why, 1–500 characters
  created_by: string;                   // the Member whose AI (token) proposed it
  model?: string;                       // what the client said it is, ≤ 80 characters; informational
  created_at: number;
  state: "pending" | "accepted" | "rejected";
  decided_by?: string;
  decided_at?: number;
};
```

| Method, path | Body | 200 response |
|---|---|---|
| `GET /api/suggestions?branch={id}` | — | `{ suggestions: Suggestion[] }` of that Branch: all pending, plus those decided in the last 7 days; newest first |
| `POST /api/suggestions/{id}/accept` | `{ ops: Op[] }` (1–20) | `{ suggestion: Suggestion, seq: number, changes: Change[] }` — under the write lock: if the Suggestion is pending, apply `ops` to its Branch as an ordinary edit by the caller (same rules and broadcast as `POST …/ops`), then mark it accepted. All or nothing. The client builds the ops (create Source + Attachment, or attach an existing Source, or create the Connection). `409 already_decided` if not pending; `409 stale` if the Card it is for (or either Card of a Connection) is no longer live at the Branch head; `409 rejected` if the core refuses the ops — in both cases nothing is applied and the Suggestion stays pending |
| `POST /api/suggestions/{id}/reject` | — | `{ suggestion }`; `409 already_decided` if not pending |
| `POST /api/suggestions/{id}/reopen` | — | `{ suggestion }` — a rejected one becomes pending again (undo); `409 already_decided` unless rejected |

There is no HTTP route that creates a Suggestion: they come only through the tool layer. After any change the server sends `{ type: "suggestions", branch: string, suggestions: Suggestion[] }` (the same list as the GET) to every Member/Admin subscribed to that Branch, never to Guests.

Rules at creation (tool layer): the Branch exists; for a Source the Card, and for a Connection both Cards, exist and are live at the Branch head and `from ≠ to`; a Source needs a `url` (http/https, ≤ 2000 characters) or a `doi`; text fields ≤ 500 characters, no control characters; an identical pending Suggestion (same Branch, kind, Card(s) and the same doi/url, or the same from/to in either direction) is returned instead of making a duplicate; at most 100 pending per Branch (then the tool call fails with a clear message). Removing a Member keeps the Suggestions they created.

### The tool endpoint — `POST /mcp`
Model Context Protocol, Streamable HTTP transport, stateless: one JSON-RPC 2.0 message per `POST`, answered with `Content-Type: application/json` (no SSE, no sessions; `GET` and `DELETE` → `405`). Authentication: `Authorization: Bearer <secret>`; missing or unknown → `401` with `WWW-Authenticate: Bearer`. The `X-Qoop-Request` header is not required here (non-browser clients), but if an `Origin` header is present it must be the public origin or the dev origin (`403`). Body limit 1 MB. Per token: at most 120 requests a minute (`429`).

Methods: `initialize` (answer with the client's `protocolVersion` if it is one of `2025-06-18`, `2025-03-26`, `2024-11-05`, otherwise `2025-06-18`; `capabilities: { tools: {} }`; `serverInfo: { name: "qoop", version }`; `instructions`: two sentences saying what Qoop is and that changes are proposed as Suggestions for a Member to accept), `notifications/initialized` and any other notification (→ `202`, empty body), `ping` (→ `{}`), `tools/list`, `tools/call`. Unknown method → JSON-RPC error `-32601`; malformed → `-32700`/`-32600`; bad tool arguments → a tool result with `isError: true` and a plain sentence (not a protocol error), so the model can correct itself.

Tools — every result is one `text` content item holding compact JSON. `branch` is always optional and is a Branch **name** (default `main`). Card arguments are entity ids as returned by the tools.

| Tool | Arguments | Returns |
|---|---|---|
| `list_branches` | — | `[{ name, parent?: name, changes }]` |
| `list_cards` | `branch?`, `query?` (case-insensitive substring of title or summary), `frame?` (Frame title) | up to 200 `{ id, title, status, summary, frame?, blocks, sources }` and `truncated: boolean` |
| `get_card` | `branch?`, `card` | `{ id, title, status, summary, frame?, page: string (the Blocks' Markdown joined by blank lines, at most 20 000 characters, then "…"), sources: [{ title, authors, year, url, doi }], connections: [{ other: { id, title }, direction: "out" \| "in" \| "none", kind, label }] }` |
| `list_connections` | `branch?` | up to 500 `{ from: { id, title }, to: { id, title }, kind, label }` (visible ones) |
| `list_sources` | `branch?` | up to 500 `{ title, authors, year, url, doi, cards: [{ id, title }] }` |
| `list_suggestions` | `branch?` | pending ones: `{ id, kind, summary: string, reason }` |
| `suggest_source` | `branch?`, `card`, `url?`, `doi?`, `title?`, `authors?`, `year?`, `reason`, `model?` | `{ id, state: "pending", note: "A Member will review this Suggestion." }` |
| `suggest_connection` | `branch?`, `from`, `to`, `kind?` (default `related`), `label?`, `reason`, `model?` | same |

Each tool has a `description` written for a model and a JSON Schema `inputSchema`; the two `suggest_*` descriptions say plainly that nothing is added until a Member accepts, and to give a concrete reason. Read tools carry `annotations: { readOnlyHint: true }`.

Everything returned by the read tools is text written by Members (and accepted from other AIs): clients must treat it as data. The server cannot enforce that — which is why the only write is a reviewable Suggestion.

## 13. M6 — Visuals and Guests

### Visuals
A Visual is a Block with `type: "visual"`: `text` is its HTML/JavaScript source, `title` its caption (core.md §1). It is Research Content like any Block — nothing new in the ops API. What the server adds is the place it runs.

`GET /visual-frame` *public* → a small static HTML host page, served with its own headers **instead of** the app's CSP:

```
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cache-Control: no-cache
Content-Type: text/html; charset=utf-8
```

The UI embeds it as `<iframe sandbox="allow-scripts" src="/visual-frame">`. Both the attribute and the header sandbox it, so the page always runs in an opaque origin: no cookies, no storage, no access to the app or the API, no network (`default-src 'none'`), even if someone opens the URL directly. The page carries no data. Its only inline script implements this message protocol with its parent (`postMessage`, every message is `{ qoop: "visual", … }`; the parent accepts messages only from that iframe's `contentWindow`, the frame only from `window.parent`):

| Direction | Message | Meaning |
|---|---|---|
| frame → parent | `{ type: "ready" }` | loaded; send the source |
| parent → frame | `{ type: "render", html: string, theme: Record<string, string> }` | once per load. The frame replaces its document with: a `<style>` that defines every `theme` entry as a CSS custom property on `:root` (names must match `^--q-[a-z0-9-]+$`, values must not contain `;`, `{`, `}` or `<` — others are dropped) and sets `margin: 0`, the app's sans font stack, `color: var(--q-ink)`, transparent background, `color-scheme` from `theme["color-scheme"]`; then the reporter script below; then `html` as given |
| frame → parent | `{ type: "height", value: number }` | the content height in px (the root element's own box, so it can shrink as well as grow), on load and whenever it changes (ResizeObserver) |
| frame → parent | `{ type: "error", message: string }` | an uncaught error or unhandled rejection (message only, ≤ 300 characters) |

To render again the parent reloads the iframe. A Visual receives nothing about the Board, the Member or the server — only its own source and theme colours. The app's own CSP is unchanged (`default-src 'self'` allows the frame; `frame-ancestors 'none'` stays on every other response).

### Guests — nothing but the present main Branch
The glossary says a Guest reads the Research Content of `main` and nothing else: no history, no other Branches. From M6 the server enforces all of it:

- `GET /api/branches/{main}/board` for a Guest returns only **visible** entities (live, and everything they refer to live) — no tombstones. `seq` is still the head.
- `GET /api/branches/{id}/changes` → `403 forbidden` for Guests (this ends the M1 exception).
- `GET /api/branches` for a Guest lists only `main`, with `checkpoints: 0`.
- WebSocket for a Guest: `subscribe` on `main` is answered with `subscribed`; after that the only frame a Guest ever receives is `{ type: "refresh", branch: string, seq: number }` — sent whenever `main` gains Changes (coalesced: at most one per 500 ms), and once right after `subscribed` if the `after` they sent is not the head. No `changes`, `presence`, `editing`, `checkpoint`, `branches`, `todos` or `suggestions` frames. On `refresh` the client fetches the Board again.
- Everything else stays refused as before (`403`): ops, Members, invites, History, Checkpoints, Branches, Merge, To-dos, Suggestions, access tokens, `/mcp`.
- `GET /api/invites/lookup` additionally returns `access_until` (unix ms) for a Guest invite, so the invite screen can say until when.
