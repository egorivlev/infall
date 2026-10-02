# `web/src/lib` — the contract between the sync layer and the UI

The UI (`src/ui/**`) imports **only** from `../../lib` (this folder's `index.ts`). It never calls `fetch` or opens a WebSocket itself. Types are in [types.ts](types.ts); the server contract is [docs/specs/api.md](../../../docs/specs/api.md).

`index.ts` exports exactly this surface (plus everything in `types.ts`):

```ts
// ---- errors ----
export class ApiError extends Error {
  status: number   // HTTP status, or 0 for a network failure
  code: string     // error.code from the server, or 'network'
  detail: unknown
}

// ---- session ----
export function useSession(): SessionSnapshot          // React hook; 'loading' until the first /api/me returns
export const session: {
  refresh(): Promise<void>                             // GET /api/me; 401 → signed_out
  login(email: string, password: string): Promise<void>      // throws ApiError
  logout(): Promise<void>
  acceptInvite(token: string, name: string, password: string): Promise<void>
}

// ---- people (Admin screens) ----
export function useMembers(): Member[]                 // cached list; [] until loaded; refetched by members.reload()
export const members: {
  reload(): Promise<void>
  remove(id: string): Promise<void>
}
export const invites: {
  list(): Promise<Invite[]>
  create(input: { email: string; role: 'member' | 'guest'; access_until?: number }): Promise<{ invite: Invite; url: string }>
  remove(id: string): Promise<void>
  lookup(token: string): Promise<{ email: string; role: Role }>   // throws ApiError 404 / 410
}

// ---- the Board ----
export function useBoard(): BoardSnapshot              // React hook; referentially stable between changes
export const board: {
  open(branchName?: string): Promise<void>             // default 'main'; loads the Board, connects the socket
  close(): void
  submit(ops: Op[]): Promise<void>                     // optimistic: applied locally at once; on rejection it is rolled back and the promise rejects with ApiError
}

// ---- op builders: pure, return ops to pass to board.submit ----
export function newId(): string                        // uuid v4
export const ops: {
  createCard(input: { id?: string; x: number; y: number; title?: string; status?: Status }): Op
  createFrame(input: { id?: string; x: number; y: number; w: number; h: number; title?: string }): Op
  createConnection(input: { id?: string; from: string; to: string; kind?: ConnectionKind; label?: string }): Op
  setText(entity: string, field: 'title' | 'summary' | 'label', text: string): Op   // '' sets Null
  setStatus(card: string, status: Status): Op
  setKind(connection: string, kind: ConnectionKind): Op
  move(entity: string, x: number, y: number): Op[]     // two Sets
  resize(entity: string, w: number, h: number): Op[]   // two Sets
  remove(entity: string): Op
  restore(entity: string): Op                          // Undelete
}
```

## Behaviour the UI can rely on

- `useBoard()` reflects optimistic ops immediately. While a drag is in progress the UI keeps its own transient position and calls `board.submit(ops.move(...))` once, on drop — never per mouse-move.
- Changes from other Members arrive without any call from the UI; the snapshot simply updates.
- If the socket drops, status becomes `'reconnecting'` and the layer reconnects with backoff and catches up; the UI only shows the state.
- `readOnly` is true for Guests; `board.submit` then rejects without sending.
- A 401 from any call flips the session to `signed_out`.
- All coordinates are Board units (px at 100% zoom). Positions and sizes are rounded to whole numbers by the op builders.
