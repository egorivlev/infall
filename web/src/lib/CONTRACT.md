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

## Notes from the implementation

- `board.open()` resolves once the Board is loaded and the socket is created; `status` stays `'loading'` until the server confirms the subscription, so `cards` can already be populated while `status` is `'loading'`. If opening fails the promise rejects and `status` is `'error'` with `error` set.
- When the session becomes `signed_out` the Board closes itself (`'idle'`). `board.close()` rejects pending submits with `ApiError{code:'closed'}`.
- `board.submit` rejects locally, without a request: Guest → 403 `forbidden`; Board not open → 400 `board_not_open`; more than 200 ops → 400; an op invalid against the current view → 409 `rejected`. An empty array resolves at once. A network failure rejects with `status 0, code 'network'`.
- `session.refresh()` never throws. `logout()` flips to `signed_out` only if the request succeeds.
- `useMembers()` is empty until `members.reload()` is called (the Board layer calls it when it meets an unknown presence id).
- Items and arrays in `useBoard()` keep their identity unless they changed, so `React.memo` on Card/Frame/Connection components works.
- A Frame without `w`/`h` on the wire gets 0; always create Frames with a size.
- The op builders throw `RangeError` on NaN or Infinity.

## M2 — Branches and History

Added to `index.ts` (types `Checkpoint`, `Activity`, `BoardPreview`, `HistorySnapshot` are in `types.ts`):

```ts
// ---- Branches ----
export function useBranches(): BranchInfo[]            // cached; [] until loaded; kept fresh by the socket's `branches` frame
export const branches: {
  reload(): Promise<void>
  create(input: { name: string; from?: Moment }): Promise<BranchInfo>   // default `from`: head of the open Branch. Throws ApiError (409 name_taken, 400). Does NOT switch; call board.open(name) after
}
// board.open(branchName) already switches Branch: it closes the current one first. Opening an unknown name rejects with ApiError 404.

// ---- History of the open Branch ----
export function useHistory(): HistorySnapshot          // referentially stable between changes
export const history: {
  open(): Promise<void>                                // load Changes + Checkpoints of the Branch the Board has open; stays current as Changes and Checkpoints arrive
  close(): void                                        // also clears the preview
  preview(seq: number | null): void                    // synchronous once open; null = back to now. Clamped to [0, head]
  createCheckpoint(name: string, seq?: number): Promise<Checkpoint>   // default: head. Works without history.open(). Throws ApiError (409 name_taken, 400)
  restore(toSeq: number): Promise<void>                // throws ApiError; the resulting Changes arrive like any others
}

// pure helpers, exported for tests and the UI
export function groupActivities(...): Activity[]       // see history.ts
```

Behaviour:

- Activities: consecutive Changes by the same author with `origin: "Edit"` and no gap over 10 minutes between neighbours form one Activity. All Changes sharing a Restore or Merge batch form one Activity of that kind, whoever's neighbours they are.
- `lines` name entities by the title they had at that moment ("Added Card Surface code basics", "Removed Card …", "Brought back Card …", "Renamed Card … → …", "Status: … → Understood", "Moved 3 Cards", "Added Frame …", "Connected A → B", "Restored to an earlier moment"). Untitled entities read "Untitled". Layout-only edits collapse into one "Moved/Resized N …" line. At most 6 lines; the last becomes "and N more" when cut.
- `preview(seq)` is computed in the browser by replaying Changes on the Branch's Board at seq 0 (fetched once by `history.open()` via `GET …/board?at=0`); no request per scrub step.
- When the Board switches Branch or closes, History goes back to `idle` and the preview clears.
- While the Board is open, `useBoard().branch` is the current `BranchInfo` including `checkpoints`.
- Guests: `history.*` and `branches.create` reject with 403 `forbidden` without sending; `useBranches()` stays `[]`.

## Notes from the M2 implementation

- `groupActivities(changes, checkpoints, baseEntities, options?)`: `changes` is the Branch's log oldest first, `baseEntities` its Board at seq 0. `options`: `gapMs` (default 10 min), `maxLines` (default 6), `startSeq` (when `changes` is only the tail of a log and `baseEntities` is the Board at that seq). The UI normally just reads `useHistory().activities`.
- More `lines` than the contract listed: "Added and removed Card …" (created and removed within one Activity), "Disconnected A → B" / "Reconnected A → B" (a Connection removed / brought back), "Labelled A → B: text", "Removed the label of A → B", "Marked A → B as contradicts", "Edited the summary of …", "Resized 1 Frame", "Moved and resized 2 Cards and 1 Frame", "Merged from another Branch", and "No lasting changes" when an Activity's edits cancel out (so `lines` is never empty).
- `lines` describe the net effect of an Activity (Board before it vs after it), in the order things were first touched, the Moved/Resized line last. Two renames read as one ("Renamed Card A → C"); an entity that has a line of its own is not counted in "Moved N …"; an added Card is named by the title it has when the Activity ends. Counts are always numbers ("Moved 1 Card").
- A Restore Activity always has the single line "Restored to an earlier moment"; `count` says how many Changes it took. A Restore that changes nothing adds no Changes and so no Activity.
- A Checkpoint does not split an Activity. Checkpoints at seq 0 are only in `useHistory().checkpoints`, never in an Activity.
- `history.open()` needs the Board to be loaded (`board.open()` resolved); otherwise it rejects with 400 `board_not_open`, as do `createCheckpoint`, `restore`, and `branches.create` without `from`. Calling `open()` again while open is a no-op. If loading fails, `status` is `'error'` and the promise rejects; call `open()` again to retry.
- `history.preview()` does nothing unless `status` is `'ready'`. The preview stays at its moment while new Changes arrive (`head` grows). Preview items keep their identity between scrub steps when unchanged, and the first preview reuses the live Board's item objects where they are equal.
- Activities that did not change keep their object identity when Changes or Checkpoints arrive; only the last Activity (or the one that gained a Checkpoint) is replaced.
- `history.restore()` and `history.createCheckpoint()` update `useBoard()` / `useHistory()` from the HTTP answer, so the UI does not need the socket to see the result. Neither waits for optimistic submits still pending.
- `useBranches()` is filled by `board.open()`, `branches.reload()`, `branches.create()` and the `branches` frame. Entries other than the open Branch can have a stale `seq` / `checkpoints` (the server only broadcasts the list when a Branch is created); for the open Branch use `useBoard().branch`. `branches.reload()` for a Guest resolves without a request.
- `branches.create()` sends `from.branch` as the Branch **id**, and `Checkpoint.moment.branch` / `BranchInfo.parent.branch` are treated as ids.
- `board.open(name)` failing (404 or otherwise) leaves the Board in `'error'` with no Branch; the previous Branch is already closed. Open `main` (or the previous name) again to recover.
- After the socket reconnects, the layer refetches the Branch list (and the Checkpoints, when History is open), since frames missed while away are not repeated.
