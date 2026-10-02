# Qoop M1 — server API contract

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
