# Infall — server API contract (M1–M18)

The contract between `crates/server` and `web/`. Both are built against this file; where they disagree with it, this file wins. Vocabulary: [CONTEXT.md](../../CONTEXT.md). Versioning rules: [core.md](core.md).

M1 scope: accounts, one Branch in use (`main`), the Board (Cards, Frames, Connections), live updates. No Branch switching, History, Merge, Pages, To-dos or AI yet — but nothing here may make those harder.

## 1. Process and configuration

Binary `qoop-server` (crate `crates/server`). Subcommands:

- `serve` (default) — run the HTTP server.
- `create-admin --email <e> --name <n>` — create the first Admin. Password is read from the env var `QOOP_ADMIN_PASSWORD` if set, otherwise prompted on the terminal without echo. Refuses if that email exists.
- `reset-password --email <e>` — set a new password for an existing account (same password input as above) and delete all of that account's sessions. The only way back in if an Admin forgets theirs; it needs shell access to the machine, which is the point.
- `import-workspace <file> --admin-email <e>` and `export-workspace <dest>` — a Workspace file into an empty Workspace, and out of this one (M18, §19).

`serve` shuts down gracefully on SIGTERM and SIGINT: it stops accepting connections, lets in-flight requests finish (so a database write is never cut off), and exits within a few seconds.

Environment:

| Variable | Default | Meaning |
|---|---|---|
| `QOOP_ADDR` | `127.0.0.1:8787` | listen address |
| `QOOP_DB` | `./qoop.db` | SQLite file |
| `QOOP_PUBLIC_ORIGIN` | `http://localhost:8787` | the origin people use; drives the cookie `Secure` flag (set when it starts with `https://`), the Origin check, and invite URLs |
| `QOOP_DEV_ORIGIN` | unset | one extra allowed Origin (e.g. `http://localhost:5173`) for local UI development |
| `QOOP_WEB_DIR` | `./web/dist` | built UI to serve; any non-`/api` path that is not a file serves `index.html` |
| `QOOP_MAX_IMPORT_MB` | `512` | the largest Workspace file `POST /api/workspace/import` takes, in MiB (a whole number ≥ 1; §19) |

## 2. Storage

SQLite (`rusqlite`, bundled). Tables: `members`, `sessions`, `invites` (and the tables of later sections), and the Research Content, kept as the append-only log it is (docs/adr/0001):

| Table | One row per | Columns |
|---|---|---|
| `branches` | Branch | `id`, `name`, `parent_branch` + `parent_seq` (the fork moment; both null only for `main`), `created_by`, `created_at` |
| `changes` | Change, key (`branch`, `seq`) | `branch`, `seq` (1 is the Branch's first Change; a Branch's rows are 1…n with no gap), `id`, `author`, `at`, `op` (the core `Op` as JSON, §5), `origin` (`edit`, `restore` or `merge`), `batch` (Restore and Merge), `to_seq` (Restore), `source_branch` + `source_seq` (Merge) |
| `checkpoints` | Checkpoint, key (`branch`, `ord`) | `branch`, `ord` (the order they were made), `name`, `seq` (its moment is (`branch`, `seq`)), `author`, `at` |
| `sync_points` | sync point a fork or Merge left, key (`branch`, `ord`) | `branch` (the child), `ord`, `base_branch` + `base_seq`, `landed_branch` + `landed_seq` (null for the fork point) |

Ids are uuid strings, times unix ms, as everywhere in the schema. Every successful mutation is written inside one transaction before the response is sent, and writes only what it adds: an edit inserts its Changes as rows; a fork, a Checkpoint or a Merge adds its rows; a Restore that forgets Merges rewrites the few `sync_points` rows of the Branches concerned. Nothing written grows with the length of the history. The `Workspace` lives in memory behind one lock; the database is read once at start, from these tables. Until schema version 5 the Research Content was one `workspace` row holding the whole `Workspace` as JSON, rewritten on every mutation.

The database runs in WAL mode with `synchronous=FULL`. The schema is created on first start and its version kept in `PRAGMA user_version` (7 now; §19 for what 7 added); a newer binary migrates an older file in place when it opens it, every step in one transaction. Before migrating, it copies the file as it is to `<db>.v<old version>-backup` beside it (owner-only on unix, synced to disk) and removes that copy only once the migration has verifiably succeeded: the step to 6 reads the Workspace back from the new tables and compares it with the old row before dropping the row, the transaction has committed, and `PRAGMA quick_check` passes (the step to 6 also compacts the file with `VACUUM` after the commit, giving back the pages of the old row). On any failure the file is left as it was, the copy stays, and the error names it. A copy left behind by a run that stopped between the commit and the removal is removed by the next open that finds the file at the current version. An older binary refuses a newer file (`newer than this binary`; for Workspace files `NewerVersion`, §17). The store sits behind a small storage trait, with an in-memory implementation for tests.

## 3. People and sessions

```ts
type Role = "admin" | "member" | "guest";
type Member = {
  id: string;            // uuid; this is the core MemberId used as Change.author
  name: string;
  role: Role;
  color: string;         // CSS colour assigned at creation from a fixed palette
  email?: string;        // present only for yourself, or when the caller is an Admin; never for an unclaimed Member
  access_until?: number; // unix ms; guests only
  claimed: boolean;      // M18: false for a Member who is a name only (§19) — no email, cannot sign in
};
```

- Passwords: Argon2id, minimum 12 characters. Never logged, never returned.
- Session: 32 random bytes, sent as cookie `qoop_session` (`HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when the public origin is https, 30-day expiry, sliding). Only a hash of the token is stored. A Local Workspace's server names its cookie differently (§16); everything else here is the same for it.
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
| `GET /api/branches/{id}/changes?after={seq}&before={seq}` | — | `{ seq: number, changes: Change[] }` — the Changes with index ≥ `after` (default 0) and, when `before` is given, < `before`, in order; `seq` is the head. `400 bad_request` if `after` or `before` is past the head or `before` is below `after` (M15b, §18) |
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

`Content-Type: application/json` for API responses. For every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, and for HTML `Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'`. Request bodies over 1 MiB are refused; `POST /api/branches/{id}/ops` accepts up to 2 MiB (§15).

## 9. M2 — History, Checkpoints, Restore, Branches

Everything in this section is for Members and Admins only; a Guest gets `403 forbidden` (a Guest has no history and no other Branches). Since M6 this includes `GET …/changes`, on `main` too: a Guest's Board catches up by fetching the Board again (§13), never by reading Changes.

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

See [ADR 0003](../adr/0003-ai-through-subscriptions-and-a-shared-tool-layer.md). The server holds no model and no model key. An AI reaches Infall through the tool endpoint with a Member's access token, can read what that Member can read, and can write exactly one thing: Suggestions. Nothing an AI sends becomes Research Content until a Member accepts it.

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

Methods: `initialize` (answer with the client's `protocolVersion` if it is one of `2025-06-18`, `2025-03-26`, `2024-11-05`, otherwise `2025-06-18`; `capabilities: { tools: {} }`; `serverInfo: { name: "qoop", version }`; `instructions`: two sentences saying what Infall is and that changes are proposed as Suggestions for a Member to accept), `notifications/initialized` and any other notification (→ `202`, empty body), `ping` (→ `{}`), `tools/list`, `tools/call`. Unknown method → JSON-RPC error `-32601`; malformed → `-32700`/`-32600`; bad tool arguments → a tool result with `isError: true` and a plain sentence (not a protocol error), so the model can correct itself.

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

## 14. M7 — the AI sidebar's server side (OpenRouter path)

See ADR 0003. In the desktop app the sidebar drives the Member's own Claude Code and never touches this section (see [desktop.md](desktop.md)). This section is the optional path for a Member who adds an OpenRouter key: the server keeps that key encrypted and relays a Conversation turn to OpenRouter, giving the model the same tools as `/mcp` (§12) acting as that Member. Conversations are **not stored on the server**: each request carries the messages, nothing is logged or kept.

Configuration (new):

| Variable | Default | Meaning |
|---|---|---|
| `QOOP_SECRET_KEY` | unset | 32 random bytes, base64. Encrypts Members' OpenRouter keys at rest (authenticated encryption, fresh random nonce per value). Unset → the OpenRouter path is off (`503 ai_not_configured` on every write below, `enabled: false` in status). `qoop-server gen-secret-key` prints a fresh one |
| `QOOP_OPENROUTER_URL` | `https://openrouter.ai/api/v1` | upstream base URL; the only host the server ever calls out to |

Members and Admins only (`403` for Guests).

```ts
type AiStatus = { enabled: boolean; key?: { last4: string; added_at: number }; model?: string };
type AiModel = { id: string; name: string; context_length?: number };
type ChatMessage = { role: "user" | "assistant"; content: string };
type AiEvent =
  | { type: "delta"; text: string }            // more of the answer
  | { type: "tool"; name: string }             // the model is calling an Infall tool (name only)
  | { type: "done"; model?: string }           // the turn is complete
  | { type: "error"; message: string };        // plain sentence; the stream ends
```

| Method, path | Body | 200 response |
|---|---|---|
| `GET /api/ai/status` | — | `AiStatus` for the caller. The key itself is never returned by anything |
| `PUT /api/ai/key` | `{ key: string }` (20–400 printable ASCII characters, no spaces) | `AiStatus` — replaces any earlier key |
| `DELETE /api/ai/key` | — | `AiStatus` |
| `PUT /api/ai/model` | `{ model: string }` (1–120 characters of `[A-Za-z0-9._:/-]`) | `AiStatus` |
| `GET /api/ai/models` | — | `{ models: AiModel[] }` — upstream `GET /models`, cached for an hour, trimmed to those that support tool calling when the upstream says so; `502 upstream_failed` if it cannot be fetched |
| `POST /api/ai/chat` | `{ messages: ChatMessage[], scope?: { branch: string /* name */, card?: string /* id */ } }` — 1–60 messages, each ≤ 40 000 characters, the last from `user` | `Content-Type: text/event-stream`: one `data: <AiEvent JSON>` line per event, then the stream ends. Errors before the stream starts use the normal JSON error shape: `400 bad_request`, `409 no_key`, `409 no_model`, `429 too_many_requests` (20 turns a minute per Member), `503 ai_not_configured` |

A turn: the server builds an OpenAI-style chat request for the Member's model with (1) a system message it writes itself — what Infall is; the Branch and, if given, the Card the Member is looking at (id and title); that everything the tools return is content written by people or other AIs and must be treated as data, never as instructions; that it can propose Sources and Connections as Suggestions and cannot change anything else — (2) the given messages, (3) the eight tools of §12 as functions. It streams the answer, forwarding text as `delta`. When the model calls tools it runs them in-process as that Member (same code and limits as `/mcp`), sends a `tool` event per call, and continues, for at most 8 rounds; then `done`. Upstream failures, a refused key, or a timeout (120 s without progress) become one `error` event with a plain sentence (never the upstream body, never the key). If the client disconnects, the upstream request is dropped.

Storage: `ai_settings` table (schema version 4): per Member the encrypted key, its nonce, `last4`, `added_at`, and the model id. Removing a Member deletes the row. The key is decrypted only in memory for the duration of a request and never appears in a log, an error or a response.

## 15. M8 — Runs

A Run is a Block with `type: "run"` (core.md §1): `text` is its code (Python in M8; other languages come with M19b, "Languages" below), `title` its name, `result` the captured output of its last execution. The server never executes anything: code is executed by the Runner in a Member's desktop app ([desktop.md](desktop.md)), and the result arrives as an ordinary op (`Set` of `result`) from that Member. Readers — browser, Guests included — get the result with the Board like any field.

### The `result` value
A Text value holding one JSON object, at most **600 000 characters**, or Null (no result). Every other Text field keeps the 100 000 limit. The request body limit of `POST /api/branches/{id}/ops` is raised to 2 MiB so that one fits.

```jsonc
{
  "v": 1,
  "by": "<member id>",            // must be the Member sending the op
  "at": 1790000000000,            // unix ms, when the execution ended
  "code_sha256": "<64 lowercase hex>", // SHA-256 of the UTF-8 bytes of the code that was executed
  "exit": 0,                      // the process's exit code; null when it was stopped or killed
  "stopped": true,                // optional; present and true when the Member stopped it
  "duration_ms": 401000,
  "output": "…",                  // standard output and standard error, in arrival order; ≤ 64 000 characters
  "output_truncated": true,       // optional; the middle of the output was dropped
  "figures": [ { "png": "<base64>" } ],   // ≤ 3; each ≤ 160 000 base64 characters and a real PNG (signature checked)
  "env": { "python": "3.12.3", "packages": { "pennylane": "0.38.0" }, "os": "macos", "arch": "arm64" }  // optional, every part optional; ≤ 32 packages (8 before M18); names ≤ 60, values ≤ 40 characters
}
```

The server checks an incoming `result` (`400 bad_request` with a plain sentence otherwise): it parses as exactly this shape — no other keys, right types, limits as above, numbers finite and non-negative where they count — `by` equals the acting Member's id, and the Block it is set on is a Run (`type` is `run` on that Branch, or becomes one in the same batch). It checks nothing about truth: a Member can write any output they like, exactly as they can write any text; the record says who.

- **Merge** (§10): a Conflict on `result` is decided by taking one side; a hand-written value for `result` is `400 bad_decision`.
- **Tools** (§12, and the same tools in §14): `get_card` lists a Run among the Page's blocks with its title, its code, and — when it has a result — who executed it (name), when, the exit code, whether the code changed since (`code_sha256` against the present code), the number of figures and the last 4 000 characters of the output. Figures (base64) are never sent to a model. No tool creates a Run, changes its code or writes a result: **AI cannot put code on anyone's machine**, and a new tool must not change that.
- **Guests** (§13): unchanged; a Run on `main` is visible with its result. Guests cannot write, so cannot record one.
- History, Restore, Checkpoints, forks: nothing new — `result` is a field like any other.

### Languages
**The server side is built (with M18): `lang` and `env` on a Run Block, `lang` and `env.runtime` in a result. The rest is M19b** (see [desktop.md](desktop.md), "Languages — Runs in more than Python", for the Runner's side).

- A Run has one more field, **`lang`** (Text): the id of the language its code is written in, `^[a-z][a-z0-9_-]{0,23}$`. Unset means `python`, so every Run that exists stays what it was. The server checks the shape when it is set on a Run (`400 bad_request` otherwise) and nothing else: it keeps no list of languages, because it executes none.
- `lang` is a field like `title`: two Branches changing it meet in a field Conflict, decided by taking one side; History and Restore need nothing new.
- A Run also has **`env`** (Text): the Toolchain environment it asks for, 1–60 characters on one line (no control characters; `400 bad_request` otherwise; Null clears it). Research Content like `lang`; the server reads nothing more into it.
- The `result` object gains two optional parts, and stays `"v": 1`:
  ```jsonc
  "lang": "julia",                              // the language it was executed as; absent means python
  "env": { "runtime": "julia version 1.11.2" }  // what the Toolchain said it is; ≤ 40 characters. Beside python, packages, os, arch
  // a result's `lang` has the Block's shape (^[a-z][a-z0-9_-]{0,23}$), else 400
  ```
  A result of a Python Run is written without either, exactly as before. A server from before this section refuses a result that carries them (`400`), so Runs in other languages need the server updated; the page says so in a sentence when that happens.
- A result of a Q# Run has `"lang": "qsharp"` and no `runtime`: its `env` is a Python Run's, `python` and one package, the one that executed it — `{ "qdk": "1.34.0" }`, or `{ "qsharp": "1.28.0" }` from a Python with only a `qsharp` of 1.28 or earlier. Since 1.29 `qsharp` is a shim whose version does not follow the compiler's, so it is never the one recorded beside a `qdk`. Nothing new for the server to check: these are the `packages` it already accepts.
- The server does not compare a result's `lang` with the Block's: like `code_sha256`, it is a record of what was executed, and the page shows a result as being from other code when either differs.
- **Tools** (§12, §14): `get_card` gives a Run's language with its code, and "the code changed since" is also true when the result's `lang` differs. No tool sets `lang`: the same characters under another language are another program, so changing it is changing what runs on someone's machine.

## 16. M12 — Local Workspaces

See [local.md](local.md). The desktop app links this crate and runs the same server in-process for a Local Workspace: `qoop_server::local::start_local` listens on `127.0.0.1` on the port asked for in `LocalOptions::port` when it is free, else on a port the OS chooses, on the caller's tokio runtime, reads no environment variables and installs no signal handlers. The public origin is `http://127.0.0.1:<port>`; there is no dev origin; the Origin rules of §3 apply unchanged. `stop` closes live connections and lets in-flight requests finish for at most a few seconds.

Files, all in the folder the desktop app gives: the database (one per Workspace) and beside it `<database file name>.secret-key` — the secret key of §14 as base64, made on the first start and kept (owner-only, mode 0600, on unix; on Windows the folder's own access rules apply). So the OpenRouter path is on in every Local Workspace.

A new database gets, before the server answers anything: one Member (role `admin`, the name the app gives, the email `me@local.invalid`, a random password nobody knows) and the Research Content of its Preset (local.md, "What each Preset seeds"), recorded as ordinary Changes by that Member and through the same checks as `POST …/ops`. The Preset id is kept in the database; a database that has one is never seeded again, and the Preset and name given at later starts are ignored.

Storage: a `settings` table (schema version 5), one text value per name: `preset`, `tutorial_state` (below), and `session_cookie` (the id in the cookie's name, below). Older files are migrated in place as in §2.

| Method, path | Who | Response |
|---|---|---|
| `GET /api/workspace` | any signed-in Member or Guest, any Workspace | `{ kind: "team", preset: null, empty: boolean, read_only: false }` or `{ kind: "local", preset: string, empty: false, read_only: boolean, moved_to?: string }` (the Preset id: `blank`, `tutorial`, `literature-review`, `research-project`; `empty`, `read_only` and `moved_to` since M18, §19) |
| `GET /api/local/enter?key=…` *public* | local only | with the key of this start: a new session for the one Member (cookie as in §3), `303` with `Location: /` and `Cache-Control: no-store`. Any other key, or none: `404 not_found` |
| `PATCH /api/local/member` | local only | body `{ name: string }`; `200 { name: string }` — the name trimmed, with the rules of accepting an invite (1–100 characters, no control characters; `400 bad_request` otherwise) |
| `GET /api/local/tutorial` | local only | `200 { state: <JSON> \| null }` — exactly what was last stored, byte for byte; `null` before anything was |
| `PUT /api/local/tutorial` | local only | body `{ state: <any JSON> }`, at most 16 KiB in all (`400 bad_request` over that, or without `state`); `204` with no body. The server stores the text of `state` as it came and never reads it |

The key of `entry_url` is 32 random bytes (URL-safe base64, no padding), made at each start, compared in constant time, and valid until `stop`. A session made with it lasts like any other (§3), but after a restart only the new key can make a new one.

**The session cookie of a Local Workspace** is called `qoop_session_<id>`, not `qoop_session`. Every Local Workspace is served from `127.0.0.1`, and a browser (the desktop app's web view included) keeps cookies apart by host and name, never by port: under one name, entering one Workspace would replace the sign-in of another, and one database's session token would be sent to another Workspace's server. `<id>` is 16 URL-safe base64 characters, made at random the first time the database is opened by `start_local` and kept in it (the `settings` row `session_cookie`), so it is the same at every start, whatever port the Workspace gets; a stored value of any other shape is replaced by a new one. It is the database's and not the port's because a Workspace whose port is taken opens on another, possibly one another Workspace had. A Workspace file leaves that row out (§17), so an imported Workspace has an id of its own. Everything that sets, reads, extends or clears the session cookie (`/api/local/enter`, every request under `/api`, the WebSocket upgrade, `logout` on a Team server) uses the server's own name, and reads no other: a cookie under another name — another Workspace's, or a `qoop_session` left from before this rule — is not looked at and signs no one in, with no error. Attributes are those of §3. A Team server's cookie is `qoop_session`, exactly as before.

On a Team Workspace every `/api/local/*` path is `404 not_found`, whatever the method and whether or not there is a session.

Refused in a Local Workspace, `403 forbidden` with a plain sentence: `POST /api/invites`, `DELETE /api/invites/{id}`, `DELETE /api/members/{id}`, `POST /api/auth/login`, and `POST /api/auth/logout` (signing out would leave no way back in). There is no HTTP route that changes a role or a password, so there is nothing more to refuse. Everything else is the same server, unchanged.

## 17. M13 — Workspace files and Source lookup

See [portability.md](portability.md) (Contracts A and B).

### Workspace files (the crate, for the desktop app)

In `qoop_server::local`:

```rust
pub fn export_workspace(db: &Path, dest: &Path) -> Result<(), PortError>;
pub fn import_workspace(file: &Path, db: &Path) -> Result<Imported, PortError>;
pub struct Imported { pub preset: Option<Preset> }   // None: a Preset id this build does not know
pub enum PortError { NotAWorkspaceFile, NewerVersion, DestinationExists, Io(String) }  // Display: one plain sentence
pub const APPLICATION_ID: i32 = 0x496e_6661;          // "Infa"
pub const WORKSPACE_FILE_EXTENSION: &str = "infall";
```

A Workspace file is a SQLite database (rollback journal, no `-wal` beside it) with `PRAGMA application_id = 0x496e6661` and the schema version of §2 in `PRAGMA user_version`. A Local Workspace's own database is not marked (`application_id` 0).

**Export** takes a consistent snapshot of the open database with `VACUUM INTO` (one read transaction, so it is safe while the server writes; only whole batches of Changes are in it) into a private scratch file beside the database, then removes from that copy, with `secure_delete` on and a `VACUUM` after, so no freed page keeps a deleted byte:

| Taken out | Why |
|---|---|
| `sessions` (all) | sign-ins on this computer |
| `invites` (all) | token hashes; a Local Workspace has none anyway |
| `access_tokens` (all) | bearer tokens for `/mcp` |
| `ai_settings` (all rows: sealed OpenRouter key, nonce, last four characters, model) | the only data sealed with the secret key of §14/§16; that key file is never copied |
| every `settings` row except `preset` and `tutorial_state` | anything a later version keeps there is left out unless it is added to the list on purpose |
| each Member's `password_hash` | replaced by the hash of a fresh random password nobody knows |

Kept: the Research Content with all its history (Changes, Checkpoints, Branches), Members (id, name, email, role, colour), To-dos, Suggestions, the Preset and the Tutorial's progress. The entry key (§16) lives only in memory and is never in a database. The clean copy is then written to `dest` (never over an existing file: `DestinationExists`; owner-only, mode 0600, on unix) and the scratch file is removed. A database whose schema is newer than the build is `NewerVersion`.

**Import** takes a Workspace file, or a Local Workspace's own database copied by hand (out of the app's data folder, or from a backup of that folder made by other means) — the way back in for a person whose only copy is `workspace.sqlite`.

It refuses, before writing anything, a file that does not start with the SQLite header (`NotAWorkspaceFile`) and a `db` that exists (`DestinationExists`). It never opens the chosen file as a database and never writes to it: it copies the file, as bytes, to a private scratch file beside `db` (`<db>.import-<random>.tmp`, owner-only on unix), and when `<file>-wal` exists beside the chosen file — a copy made while the app was running, whose newest Changes are only in that write-ahead log — it copies that too, to `<scratch>-wal`, so SQLite reads them in. A `-shm` beside it is not used (SQLite rebuilds it from the `-wal`). The scratch copy is checked: its `application_id` is the Infall mark or none (any other: `NotAWorkspaceFile`), a schema version not newer than this build (`NewerVersion`), `PRAGMA quick_check`, the tables of a Local Workspace, a `preset` setting, exactly one Member who is an Admin, and a Workspace that reads — its `workspace` row in a file older than schema version 6, its tables (§2) in a later one (else `NotAWorkspaceFile`). A file of an older schema version is imported as it is and migrated when the Workspace is first opened. Then it is cleaned:

- a **Workspace file** (marked): any sessions, invites, access tokens and AI settings are removed (in case a file was made by hand);
- an **unmarked database**: exactly what an export takes out (the table above: sessions, invites, access tokens, AI settings, every setting but `preset` and `tutorial_state`, each Member's password hash), with `secure_delete` and a `VACUUM`, the `-wal` folded in, and the mark set — the result is what an export of that database would have been.

Only then is the clean copy written to `db` (owner-only on unix, never over a file that appeared meanwhile: `DestinationExists`), and the scratch files are removed. If any check fails, nothing is written to `db` and no scratch file is left. The new database is migrated to the current schema by `start_local` like any database; since it has a Preset and a Member, nothing is seeded and the `preset` and `member_name` of `LocalOptions` are ignored. The secret key file is made afresh at that first start, and so is the id in the session cookie's name (§16).

A Team Workspace's database, copied by hand or given as it is, is refused as `NotAWorkspaceFile` (it has no Preset and no mark). Since M18 a Team Workspace's **file** (marked, `file_kind` `team`) imports as a Local Workspace, and `export_workspace` of a Team database makes such a file (§19).

### Source lookup

Configuration (new; a Local Workspace always uses the defaults):

| Variable | Default | Meaning |
|---|---|---|
| `QOOP_CROSSREF_URL` | `https://api.crossref.org` | where DOIs are looked up |
| `QOOP_ARXIV_URL` | `https://export.arxiv.org` | where arXiv ids are looked up |

Besides OpenRouter (§14), these are the only hosts the server calls out to, and only when a Member asks. The whole lookup has a 10 s limit (`Config::lookup_timeout`, not read from the environment). The request carries only the id: the server's generic `User-Agent` (`qoop-server/<version>`), `Accept`, no cookie, no name, nothing about the Workspace. Redirects are not followed and no proxy is used (the same HTTP client as §14).

`POST /api/sources/lookup` — Members and Admins, Team and Local Workspaces alike (`403 forbidden` for Guests, `401` without a session). Body: exactly one of

```ts
{ doi: string }    // "10.1038/nature12373"; also "doi:…" and "https://doi.org/…" / "dx.doi.org"
{ arxiv: string }  // "2103.05577", "2103.05577v2", "hep-th/9711200"; also "arXiv:…" and arxiv.org
                   // (www., export.) addresses under /abs/, /pdf/ (".pdf" dropped), /html/
```

A DOI is `10.` + 4–9 digits + `/` + a suffix, without white space, at most 300 characters.

| Status | Body | When |
|---|---|---|
| `200` | `{ title: string, authors: string, year: string, doi: string \| null, url: string \| null }` | found |
| `400 bad_request` | usual error body | neither key, both, a value that is not a string, or not a DOI / arXiv id. Nothing is sent anywhere and nothing is counted |
| `404 not_found` | usual error body; the sentence names the registry | Crossref answers `404`; arXiv's feed has no entry, an error entry, or an entry without a title |
| `429 too_many_requests` | usual error body | more than 30 lookups by this Member in a minute (refused ones are not counted) |
| `502 lookup_failed` | usual error body, a sentence that ends with what to do (try again, or fill in the fields by hand) | the registry could not be reached, answered with another error status, took longer than 10 s, or answered with something that is not what it should be (more than 2 MiB included). Never the registry's own text |

The answer:

- `title` — plain text: tags (`<i>`, `<sub>`, MathML) removed without breaking words, HTML entities decoded (named, decimal, hex), white space collapsed, at most 2 000 characters. arXiv titles keep their TeX as written.
- `authors` — the form a Source's `authors` already has in the seeds and the web UI: each name as "Given Family" (Crossref `given` + `family`, else `name`; arXiv `<name>` as is), joined by `", "`. Past 100 names the list ends in `", et al."`.
- `year` — Crossref: the first of `issued`, `published`, `published-print`, `published-online`, `created` that has a year; arXiv: the year of `<published>`.
- `doi` — Crossref: the DOI it gives (else the one asked); arXiv: the `<arxiv:doi>` of the paper when it has one, else `null`.
- `url` — Crossref: `null` (the DOI is the identifier); arXiv: `https://arxiv.org/abs/<id as asked, version included>`.
- A field the registry lacks is `""`.

Nothing is stored; the web UI fills its form with the answer and saves through the ordinary ops (§11).

Crossref is asked `GET <crossref>/works/<doi>` (everything but unreserved characters and `/` percent-encoded), arXiv `GET <arxiv>/api/query?id_list=<id>&max_results=1`.

## 18. M15b — the Branch Graph

Members and Admins only; a Guest gets `403 forbidden`. The same in a Team and a Local Workspace. Why and what the screen does with it: [branch-graph.md](branch-graph.md).

| Method, path | Body | 200 response |
|---|---|---|
| `GET /api/graph?gap_ms={ms}` | — | `{ branches: GraphBranch[] }` — the shape of every Branch, without the contents of any Change. `gap_ms` (default 600000) is the longest pause inside one edit Activity; `400 bad_request` when it is not a whole number ≥ 0 |

```ts
type GraphBranch = {
  id: string; name: string;
  seq: number;                       // the head: how many Changes it has
  parent?: Moment;                   // where it was started from; absent for main
  created_by?: string; created_at?: number;   // absent for main
  checkpoints: { name: string; seq: number; author: string; at: number }[];  // by seq, then name; seq 0 = at its own start
  activities: GraphActivity[];       // oldest first
};
type GraphActivity = {
  kind: "edit" | "merge" | "restore";
  author: string;                    // the author of its first Change (one Member for every kind)
  from_seq: number; to_seq: number;  // it covers the Changes (from_seq, to_seq] of its Branch
  started_at: number; ended_at: number;   // `at` of its first and of its last Change
  source?: Moment;                   // kind "merge" only: the moment of the other Branch it brought in
  to?: number;                       // kind "restore" only: the moment of this Branch it returned to
};
```

- `branches`: `main` first, then by `created_at`, ties by id.
- The Activities of a Branch are in its own order, do not overlap, and together cover `(0, seq]`; a Branch without Changes has none.
- Grouping (the same rule as History's, CONTEXT.md "Activity"): consecutive `Edit` Changes by one author with no pause over `gap_ms` between neighbours are one Activity (a clock that went backwards is no pause; the next pause is measured from that earlier time); the Changes of one Restore or Merge batch are one Activity of that kind; and **a Checkpoint always ends the Activity it falls in** — no Activity reaches across the moment of a Checkpoint of its Branch, a Merge or a Restore batch included (each part keeps the kind, `source` and `to`). A Checkpoint at seq 0 or at an Activity's end changes nothing. The rule is checked against the fixture [branch-graph-activities.json](branch-graph-activities.json) by the server's and the web library's tests.
- A Merge that changed nothing appended no Change and so is in no Activity. A Restore that changed nothing likewise.
- Built in one pass over each Branch's log, under the read lock; no Board is rebuilt. 50 000 Changes answer in well under a second.
- Nothing pushes the graph: the `branches` frame (§9) is the signal that a Branch or a Merge was added, `changes` and `checkpoint` frames cover the open Branch.

`GET /api/branches/{id}/changes` takes `before` (§6) so that the text of a few Activities can be read without the whole log: `?after={from_seq}&before={to_seq}` gives exactly the Changes of the Activities in between.

## 19. M18 — from alone to a team: Workspace files onto and off a Team server, Members as names, Comments, For you

See [team-move.md](team-move.md) (decisions 1–9, Contracts A and B). All refusals use the usual error body (§4).

New error codes:

| Status | Code | When |
|---|---|---|
| 403 | `moved` | any changing request in a moved Local Workspace; message "This Workspace was moved to a Team server; open it there to make changes." |
| 409 | `not_empty` | a Workspace file into a Workspace that is not empty |
| 400 | `not_a_workspace_file` | what was sent is not a Workspace file this server can read |
| 413 | `too_large` | a Workspace file over `QOOP_MAX_IMPORT_MB` |
| 422 | `newer_version` | a Workspace file made by a newer schema version |

### Storage (schema version 7)

Migrated in place from every earlier version as in §2. `members` is made again with `email` allowed to be null (the documented create–copy–drop–rename, which the migration runs with foreign keys off and checks with `PRAGMA foreign_key_check` before it commits). `invites` gains `claims` (a Member id or null). New tables, beside the content tables and outside versioning like `todos`:

| Table | One row per | Columns |
|---|---|---|
| `comments` | Comment | `id`, `card` (entity id; not checked against any Board), `author`, `text`, `mentions` (JSON array of Member ids), `created_at`, `edited_at` (null until edited) |
| `comment_threads` | Card whose thread was ever resolved or reopened | `card`, `resolved`, `resolved_by`, `resolved_at` |
| `for_you` | mention of one Member in one Comment, key (`member`, `comment`) | `member`, `comment`, `card`, `author`, `at`, `seen` |

`settings` may hold `content_epoch`, changed whenever a Workspace file replaces the content. A server that read the Workspace before that change refuses to write it (`500 internal`, logged "restart the server"). That is the case of `import-workspace` run while a server runs on the same database: without it the server would write its empty Workspace over the one brought in.

### Workspace files of schema version 7

Since version 7 a Workspace file's `settings` say which kind of Workspace it came from and who exported it:

| Setting | Value |
|---|---|
| `file_kind` | `local` or `team` |
| `exported_by` | the Member id of whoever exported it: a Local Workspace's one Member; the Admin who exported over HTTP; for `export-workspace`, and `export_workspace` of a Team database, the oldest Admin (by `created_at`, then id) |

- **Local file** (`export_workspace` and `export_for_move` of a Local database): §17's table, plus `file_kind` and `exported_by`. Comments, threads and For you lists are kept. A Member who is a name only has an empty password hash.
- **Team file** (`GET /api/workspace/export`, `export-workspace`, `export_workspace` of a Team database): taken out are sessions, invites, access tokens, AI settings (keys, nonces, last four characters, models), **every** setting, Guests (with their For you entries), and from every Member the email (null), the password hash (empty) and `access_until`. Kept: the id, name, role, colour and `created_at` of each Member and Admin; every Branch, Change, Checkpoint and sync point; To-dos; Suggestions; Comments, threads and For you lists. `secure_delete` and a `VACUUM` as in §17. The file is made from a consistent snapshot (`VACUUM INTO` on its own connection), so it is safe while a server writes, in the same process or another.

A Workspace file of an older version imports as before (§17) and, onto a Team server, is first brought up to version 7.

### Contract A — `qoop_server::local`

```rust
pub struct LocalOptions { /* §16 */ pub read_only: bool, pub moved_to: Option<String> }
pub struct Imported { pub preset: Option<Preset>, pub from_team: bool }
pub fn export_for_move(db: &Path, dest: &Path) -> Result<(), PortError>; // = export_workspace
pub fn build_local_app_with(config, store, clock, preset, member_name, read_only: bool, moved_to: Option<String>) -> Result<LocalApp, StartError>;
```

- **Read-only** (`read_only: true`): every request under `/api` whose method is not `GET`/`HEAD` is `403 moved` before any handler runs, except `POST /api/sources/lookup`, which only reads. Reading, search, History, the Branch Graph and the exports to Markdown, BibTeX and image (all reads) keep working, and so do `GET /api/local/enter` and the WebSocket's `subscribe`. There are no ops over the WebSocket; the one thing a client sends there that changes anything, an `editing` claim, is answered with `{ type: "error", code: "moved", message }`. The tool layer (`/mcp` and the AI sidebar's tools) refuses `suggest_*` with the same sentence. A moved Workspace's start does not rename its Member.
- `GET /api/workspace` in a Local Workspace gives `read_only` as passed, and `moved_to` (the Team origin) when `LocalOptions::moved_to` is set; otherwise the key is absent.
- **`import_workspace` of a Team file** (decision 6): the Member in `exported_by` becomes the one Member who can sign in (role `admin`, email `me@local.invalid`, a fresh random password). Every other Member stays a name only (email null, role `member`); Guests are dropped; the settings become `preset` = `blank` and `name_member_on_start`. The first `start_local` names that Member `LocalOptions::member_name` (the computer's user, as for a new Workspace) and forgets the setting. Returns `Imported { preset: Some(Blank), from_team: true }`. A Local Workspace's check (§17) now asks for exactly one Member who can sign in, an Admin, and allows other Members who are names only.

### Workspace (Contract B)

| Method, path | Who | Body | Response |
|---|---|---|---|
| `GET /api/workspace` | any signed-in | — | §16's shape with `empty` and `read_only` (and `moved_to` when set) |
| `POST /api/workspace/import` | Admin, Team (`403` in a Local Workspace and for Members and Guests, `401` without a session) | the Workspace file as the raw body (any `Content-Type`; the UI sends `application/octet-stream`), at most `QOOP_MAX_IMPORT_MB` MiB. The usual write rules of §3 apply (`Origin`, `X-Qoop-Request: 1`) | `200 { members: { id, name, claimed }[], you_were: string }` |
| `GET /api/workspace/export` | Admin, Team (`403` otherwise) | — | `200`, `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename="<host of the public origin, ':' as '-'>.infall"`, `Cache-Control: no-store`, the Team file |

**Empty** (decision 1): `main` is the only Branch, with no Changes and no Checkpoints, and there are no To-dos and no Comments; Members and invites may exist. Always `false` in a Local Workspace. "Start empty" needs nothing from the server: `empty` stays `true` until the first Change, Checkpoint, Branch, To-do or Comment.

**Import.** Refused before the body is read when the Workspace is not empty (`409 not_empty`). The body is streamed to a private scratch file beside the database (`413 too_large` as soon as it passes the limit, or at once from `Content-Length`). Then, under the Workspace write lock, the file is checked as §17 checks (`400 not_a_workspace_file`, `422 newer_version`), brought to version 7 and stripped as a Team file is. Its owner (a Local file's one Member, decision 2; a Team file's `exported_by`, decision 7) becomes the importing Admin **everywhere**: Changes, Checkpoints, Branches made, To-dos (owner and creator), Suggestions, Comments and their mentions, thread resolutions, For you entries, and inside Change ops (a Pin's `ai_pinned_by` and `ai_reviewed_by`, a Run result's `by`). Every other Member of the file is added as a name only (email null, role `member`, no password), unless a Member with that id is already on the server, who keeps their account. The file's `main` takes the server's `main` id, so connected clients stay on it; other Branch ids are kept. In one transaction, with the emptiness checked again, the server's empty content, Suggestions, Comments and For you lists are replaced by the file's and the Members are added. On any failure nothing changes. Afterwards everyone connected gets §7's catch-up after missed frames: the full `branches` frame, all of `main` as one `changes` frame, `presence`, `editing`, `todos`, `suggestions`; a Guest gets one `refresh`. In the answer, `members` lists every Member and Admin on the server after the import (Guests left out) in the Members list's order, and `you_were` is the owner's name in the file, whose work is now the Admin's.

### Command line

- `qoop-server import-workspace <file> --admin-email <e>`: the same rules and work as the import above, with the existing Admin of that email (case and surrounding spaces ignored) as the importing Admin. Exits non-zero and changes nothing when there is no such Admin, when the Workspace is not empty, or when the file cannot be read as a Workspace file. Prints whose work came in and the names not signed in yet. A server running on the same database refuses to write afterwards until it is restarted (`content_epoch` above): run it with the server stopped, or restart the server.
- `qoop-server export-workspace <dest>`: a Team file of `QOOP_DB` at `dest` (which must not exist), recording the oldest Admin as who exported it. Safe while the server runs on that database in another process: the file is a consistent snapshot.

### Members (Contract B)

- `Member` gains `claimed: boolean` (§3). An unclaimed Member has no email (none is shown to anyone) and cannot sign in. They can be mentioned, can own To-dos, and are removed with `DELETE /api/members/{id}` like any other.
- `POST /api/invites` takes an optional `claims: "<member id>"`, which must be an unclaimed Member who is not a Guest (`400 bad_request` otherwise, also for an id that is not a uuid). `Invite` gains `claims?: string`. `GET /api/invites/lookup` adds `claims: { id, name }` for such an invite.
- Accepting a claiming invite (`POST /api/auth/accept-invite`, same body) gives that Member the invite's email and role, the typed password and the typed name, and signs them in as that Member (same id, colour and `created_at`), so everything under the name is theirs. If the Member was claimed or removed meanwhile: `410 invite_expired`. `409 email_taken` as usual.

### Comments (Contract B)

Members and Admins, Team and Local; Guests get `403 forbidden` on every one; `401` without a session. A Card id in a path that is not a uuid is `404`.

```ts
type Comment = { id: string; author: string; text: string; mentions: string[]; created_at: number; edited_at: number | null };
type ForYouItem = { comment: string; card: string; author: string; at: number; seen: boolean };
```

| Method, path | Body | Response |
|---|---|---|
| `GET /api/cards/{card}/comments` | — | `200 { resolved: boolean, comments: Comment[] }`, oldest first; a Card without a thread gives `{ resolved: false, comments: [] }` |
| `POST /api/cards/{card}/comments` | `{ text, mentions?: string[] }` (`mentions` defaults to `[]`) | `201` the bare Comment. The Card need not exist on any Branch |
| `PATCH /api/comments/{id}` | `{ text, mentions?: string[] }` (without `mentions` they are kept) | `200` the bare Comment, `edited_at` set. Author only (`403`); `404` unknown |
| `DELETE /api/comments/{id}` | — | `200 {}`. Author or an Admin (`403`); `404` unknown. Its For you entries go with it |
| `PUT /api/cards/{card}/comments/resolved` | `{ resolved: boolean }` | `200 { resolved }`. Any Member. `404` when the Card has no Comments |
| `GET /api/comments/counts` | — | `200 { "<card id>": { open: number, resolved: boolean } }` for every Card with at least one Comment; `open` is the number of Comments in the thread, resolved or not |
| `GET /api/for-you` | — | `200 { items: ForYouItem[] }`, the caller's, newest first (by `at`, then comment id), at most 200 |
| `POST /api/for-you/seen` | `{ up_to: "<comment id>" }` | `200 { count }`: that entry and every older one are marked seen; `count` is how many of the caller's entries are still unseen. `404` when the caller's list has no entry for that Comment |

- `text` is trimmed and must be 1–10 000 characters, with no control characters other than line breaks and tabs (`400 bad_request`). It is plain text with a Page text block's inline Markdown and math; the server does not read it.
- Each of `mentions` must be the id of a Member or Admin (unclaimed ones included), never a Guest's or an unknown id (`400 bad_request`). An id given twice is kept once. The server does not look for `@Name` in the text.
- **For you**: a new Comment gives each Member it mentions an unseen entry (`at` = its `created_at`). An edit gives one (`at` = `edited_at`) only to Members it mentions now and did not before. Nobody gets an entry for mentioning themself. Each Member's list keeps its newest 200 entries. Removing a Member removes their list.
- Outside versioning: the same on every Branch, not in History, never merged, and kept when the Card is removed. Workspace files carry them both ways (above).
- Live, to every connected Member and Admin, never to Guests: `{ type: "comments", card }` after a Comment is written, edited or deleted and after a thread is resolved or reopened; `{ type: "for_you", count }` to a Member's own connections when their unseen count may have changed (a mention, an edit that adds them, a deletion that took one of their entries, their own `seen`). The client fetches the thread or the list again.
- In a moved Local Workspace every write above is `403 moved`.
