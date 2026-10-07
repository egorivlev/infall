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

## M3 — Merge

Added to `index.ts` (types in `types.ts`: `MergeSnapshot`, `ConflictVM`, `ConflictSide`, `AutoLine`, `Choice`, plus the wire types):

```ts
export function useMerge(): MergeSnapshot              // referentially stable between changes
export const merge: {
  open(sourceName: string, targetName: string): Promise<void>   // plans the Merge and loads both Boards for titles; never throws — failures land in the snapshot (status 'error', errorCode)
  close(): void
  decide(conflictId: string, choice: Choice | null): void       // null clears
  setCheckpointName(name: string): void
  apply(): Promise<void>                               // rejects with ApiError if it could not be applied; see below
  refresh(): Promise<void>                             // plan again, keeping choices that still fit
}
export function mergeOptions(branch: BranchInfo, all: BranchInfo[]): { intoParent?: BranchInfo; fromParent?: BranchInfo }  // the two Merges allowed for a Branch (v1: only with its direct parent)
```

Behaviour:

- Independent of the open Board: it fetches by Branch name (`GET /api/branches`, `GET …/board` for both heads, `GET …/checkpoints` of the target, `GET /api/merges/plan`). Works while the Board shows any Branch.
- `apply()` needs every Conflict decided (rejects locally with 400 `undecided` otherwise) and a non-empty Checkpoint name. On success: status `'merged'` with `result`; if the open Board is the target, its Changes arrive as usual.
- `409 stale` from the server: the layer plans again, keeps every choice whose Conflict is unchanged (same key, same source and target values), sets `replanned: true`, status back to `'ready'`, and `apply()` rejects with the ApiError (code `stale`) so the UI can say what happened. `409 name_taken`: status back to `'ready'`, rejects.
- A `{ custom }` choice is sent as `{ Custom: { Text } }` (empty string → `"Null"`), only where `canEdit`.
- `autoSummary`, `AutoLine`s and all texts use titles from the source Board (the target Board for things only there). Layout-only automatic Sets are not listed as lines; they are counted in the summary as "N moved or resized".
- Guests: `merge.open` ends in status `'error'`, errorCode `forbidden`, without a request.

## Notes from the M3 implementation

- Code: `merge.ts` (the store: `merge`, `useMerge`), `merge-view.ts` (pure: view models, wording, Decisions, `mergeOptions`). The M3 types in `types.ts` are unchanged.
- `merge.open()` first asks for the Branch list (and fills `useBranches()`), then plans. `source` / `target` are set as soon as the names are found, so they are also there in most `'error'` snapshots (not for an unknown name or a Guest). An unknown name ends in `errorCode: 'not_found'` ("There is no Branch named X.") without planning. `error` is always a plain sentence; `errorCode` is the server's code, `'network'`, or `'forbidden'`.
- `mergeOptions(branch, all)`: both `intoParent` and `fromParent` are the **parent's** `BranchInfo` (merge `branch` into it / bring it into `branch`). `{}` for `main` and while the parent is not in `all`. Call `merge.open(branch.name, parent.name)` or `merge.open(parent.name, branch.name)`.
- `decide()`, `setCheckpointName()` work only while `status` is `'ready'`; an unknown Conflict id and a `{ custom }` choice on a Conflict without `canEdit` are ignored. Conflicts whose choice did not change keep their object identity.
- `apply()` rejects locally, without a request: Guest → 403 `forbidden`; not `'ready'` → 400 `not_ready`; undecided Conflicts → 400 `undecided` (`detail`: their `ConflictKey[]`); blank Checkpoint name → 400 `bad_request`. The Checkpoint name is sent trimmed. Any server refusal other than `stale` (`name_taken`, `undecided`, `bad_decision`, `rejected`, a network failure, …) puts `status` back to `'ready'` with all choices and rejects.
- After `stale` the default Checkpoint name is recomputed; a name typed by hand is kept. If planning again fails too, `status` is `'error'` and `apply()` still rejects with the `stale` error.
- On success the layer hands the Merge's Changes and Checkpoint to the open Board itself when it shows the target (no need to wait for the socket), updates `target.seq` / `target.checkpoints` in the snapshot and refetches the Branch list. The snapshot stays `'merged'` until `close()` or the next `open()`.
- `refresh()` never throws and does nothing while `idle`, `loading`, `applying` or `merged`. From `'ready'` the review stays visible with `status: 'loading'` while it plans again; `replanned` becomes true only if the plan came back different. From `'error'` it starts over like `open()` (choices are gone).
- `close()` and a newer `open()` make late answers harmless. An `apply()` already sent still happens on the server; its promise then resolves without touching the snapshot. Signing out closes the review.
- Conflict wording:
  - Field Conflicts: `headline` is "Title / Summary / Status / Label / Kind / Start / End changed on both" (any other field: its name, capitalised). Side `text`: the text itself, "(empty)" for none; a Status word ("Open question") with `status` set (unset reads Idea); a Connection kind as "Related" / "Directed" / "Contradicts"; a Connection end as the Card's title on that side's Board.
  - Edit vs delete: `headline` is "Deleted on <branch>, edited on <other>", or "… kept on <other>" when the live side's content is what the base had (or the base did not have the entity live) — the case where a Delete or Undelete made by hand would be reversed. The side that has it deleted reads "Delete the Card" (deleted on the source: choosing it deletes) or "Leave the Card deleted" (deleted on the target). The live side reads "Keep the Card with its edits: title, summary" (live on the target) or "Bring back the Card with its edits: status" (live on the source); without edits just "Keep the Card" / "Bring back the Card". "Card" is the entity's kind; a Connection's `from` / `to` read "start" / "end". The types' example "Deleted on try-QEC, brought back on main" is not produced.
  - `author` / `at`: the last Change on that Branch that set the field (edit vs delete: its Delete on the deleted side; its last content Set, Create or Undelete on the live side). Changes made on the base's Branch before the base are not counted. Absent when the Branch has no such Change or its Changes could not be loaded.
- `auto`: one line per entity, in the plan's order. `what` is the title for added / removed / brought-back entities; an added Connection reads "A → B · label" (no label: "A → B"); a `'Change'` reads "Title · summary, status" (the fields that change, by the same words as above). The Sets that come with a brought-back entity belong to its line. Entities with only layout Sets, and entities that arrive already deleted (kept so that Connections stay valid), have no line.
- `autoSummary` counts things, not ops: "9 Changes · 3 Cards added, 2 Connections added, 4 other Changes"; parts in this order: Cards added, Frames added, Connections added, other Changes, "N removed", "N brought back", "N moved or resized", "N added and removed". With a single part it is just that part ("3 Changes", "1 Card added", "2 moved or resized"). "Nothing to merge automatically" when the plan has no automatic ops. `result.changes` (real Changes that landed) is usually larger than these counts.
- `nothingToMerge` is about the plan (no automatic ops, no Conflicts); `layoutKept` can still be above 0. `apply()` on such a plan is allowed and only places the Checkpoint.
- Requests per `open()`: the Branch list, the plan, both head Boards, the target's Checkpoints, each Branch's Changes once; plus the base Board only when there is an edit-vs-delete Conflict, and a Board `?at=` only if a Branch moved between the requests. Planning again (stale, `refresh()`) fetches only Changes it does not have yet. A failure to load Changes or the base Board is not an error: authors are then absent, and edit vs delete reads "edited" without listing fields.

## M4 — Pages, Sources, To-dos

Added to `index.ts` (types `BlockVM`, `SourceVM`, `AttachedSource`, `PageVM`, `Todo` in `types.ts`; `CardVM` gains `blocks` and `sources` counts):

```ts
// ---- Page of a Card (on the open Branch; reflects optimistic ops like useBoard) ----
export function usePage(cardId: string | null): PageVM      // referentially stable between changes; empty PageVM for null
export function useSources(): SourceVM[]                    // every live Source on the open Branch, by title
export const page: {
  startEditing(cardId: string): void                        // claims the soft lock (socket `editing` frame); idempotent
  stopEditing(): void
  findSource(input: { url?: string; doi?: string }): SourceVM | undefined   // match by normalised DOI, else normalised URL
}
export function normalizeDoi(text: string): string          // '' if not a DOI; accepts 'doi:…', 'https://doi.org/…'; lower-cased
export function normalizeUrl(text: string): string          // '' if not http(s); trims, drops fragment and trailing slash
export function orderBetween(before?: string, after?: string): string   // an order key strictly between the two (either may be absent)

// ---- more op builders (pure) ----
ops.addBlock(input: { id?: string; card: string; text: string; order: string }): Op
ops.setBlockText(block: string, text: string): Op           // '' is allowed (an empty block); use ops.remove to delete
ops.moveBlock(block: string, order: string): Op
ops.createSource(input: { id?: string; url?: string; doi?: string; title?: string; authors?: string; year?: string; note?: string }): Op
ops.setSourceField(source: string, field: 'url' | 'doi' | 'title' | 'authors' | 'year' | 'note', text: string): Op
ops.attach(input: { id?: string; card: string; source: string }): Op
// detach = ops.remove(attachmentId); ops.remove / ops.restore work for Blocks, Sources, Attachments too

// ---- To-dos (not Research Content: same on every Branch) ----
export function useTodos(): Todo[]                          // cached; [] until loaded; kept fresh by the socket `todos` frame
export const todos: {
  reload(): Promise<void>
  add(input: { owner: string; text: string; card?: { id: string; title: string; branch: string } }): Promise<Todo>
  setDone(id: string, done: boolean): Promise<void>         // owner only (rejects 403 locally otherwise)
  edit(id: string, patch: { text?: string; card?: { id: string; title: string; branch: string } | null }): Promise<void>
  remove(id: string): Promise<void>
}
```

Behaviour:

- Blocks/Sources/Attachments are ordinary entities in the Board store; `useBoard()`'s `cards/frames/connections` are unchanged apart from the two counts. A Block or Attachment whose Card (or Source) is not live is not shown anywhere.
- Soft lock: `PageVM.editor` is set while someone else holds that Card's Page. The layer re-sends the claim after a reconnect and drops it on `board.close()`/Branch switch. Guests never claim.
- `todos.*` update the cache optimistically and roll back on failure (rejecting with ApiError). The list is loaded by `board.open()` for Members and refetched after a reconnect.
- History and Merge texts cover the new kinds: Activities read "Edited the Page of <Card>", "Added a block to the Page of <Card>", "Removed a block from the Page of <Card>", "Reordered the Page of <Card>", "Added Source <title> to <Card>", "Removed Source <title> from <Card>", "Edited Source <title>"; in a Merge a Block `text` Conflict has `entityTitle` "Page: <Card title>", `headline` "Paragraph changed on both", `canEdit: true`, and Auto lines "Page of <Card> · N blocks"/"Source <title>". `BoardPreview` is unchanged (the Page panel is not available while previewing History).

## Notes from the M4 implementation

- Code: `board-state.ts` (parsing the new kinds, `toPageIndex`, `toPage`), `board-sync.ts` (the store now also holds what Pages are made of; soft lock; feeds To-dos), `page.ts` (`page`, `usePage`, `useSources`), `sources.ts` (`normalizeDoi`, `normalizeUrl`, matching), `order.ts` (`orderBetween`), `todos.ts`, plus wording in `activities.ts` and `merge-view.ts`. The M4 types in `types.ts` are unchanged.
- `usePage(id)` returns one shared empty `PageVM` (`card: null`) for `null`, for a Card that is not live, and while no Board is open. Otherwise the same object comes back until that Page changes: another Card moving, typing in another Page, presence, a Source not attached here — none of these re-render it. Inside a new `PageVM`, `blocks`, `sources`, `connections` and each item keep their identity when unchanged. `card` is the very object from `useBoard().cards`, so the Page does change when its own Card moves; a `connections` entry changes when the Card at its other end changes.
- A text edit in a Page does not touch `useBoard()` at all (the counts are the same); adding or removing a block or an Attachment replaces only that Card's `CardVM`.
- `PageVM.connections`: the visible Connections of the Card, by id. `direction` is `'out'` / `'in'` only for kind `directed` (from this Card / to it); `related`, `contradicts` and a Connection from a Card to itself read `'none'`.
- `PageVM.sources`: newest year first (the leading number of `year`), Sources without a readable year last, then by title ignoring case, then id. `useSources()`: by title ignoring case, then id; a Source without a title comes first. `SourceVM.cards` is sorted by id.
- A Source attached to one Card by two Attachments (possible after a Merge) is shown and counted once; `attachment` is the one with the smaller id, and detaching it leaves the Source attached by the other.
- `BlockVM.type` is always `'text'`; an emptied block reads `text: ''`. `ops.setBlockText(b, '')` sets Null and `ops.addBlock` with `text: ''` leaves the field unset — the same thing on the wire.
- `board.submit` also refuses locally (409 `rejected`) a block whose `card` is not a Card on the Board and an Attachment whose `card` / `source` are not a Card and a Source; deleted ones are accepted, as in the core.
- Op builders: `createSource` / `setSourceField` trim `url` and `doi` (what identifies a Source) and keep the other fields as typed; an empty text is left unset / sets Null. Neither normalises: `findSource` does that on both sides. `addBlock` / `moveBlock` throw `RangeError` on an empty `order`.
- `orderBetween`: keys are made of `0-9A-Za-z` (62 digits in plain string order) and never end in `0`; the first key is `U`. Appending or prepending steps by one digit (a key grows by a character about every 60 blocks); inserting between two keys bisects, except that typing downwards in one gap also steps (about 60 blocks per character); always inserting right after the same block costs a character per 5 blocks. When nothing can lie between the arguments — they are equal or out of order, hold other characters, or `after` is `before` followed by zeros — it returns a key right after `before` instead of throwing. Equal keys happen when two Branches insert at the same place and are merged; the two blocks then order by id, and to put something between them move one of them first.
- `normalizeDoi` accepts a bare DOI (`10.` + 4–9 digits + `/…`), `doi:` / `DOI: ` in front, and `doi.org`, `dx.doi.org`, `www.doi.org` addresses with or without `http(s)://` and percent-encoding; it drops surrounding whitespace and a trailing `.`, `,` or `;`. A DOI inside any other address is not recognised. `normalizeUrl` also lower-cases scheme and host and drops the default port; path case and the query are kept; text without `http://` / `https://` gives `''`.
- `page.findSource` looks through the live Sources of the open Branch, optimistic ones included, in `useSources()` order. A DOI wins over the address; a `doi.org` address counts as a DOI, in the input's `url` and in a Source's `url` alike. `undefined` when nothing readable was given.
- Soft lock: `page.startEditing` does nothing while no Board is loaded and for Guests; before the socket is subscribed the claim is kept and sent once it is. One claim at a time: claiming another Card replaces it. The claim is made again on every reconnect and forgotten by `board.close()`, a Branch switch and signing out (the layer also says `card: null` before closing the socket). While the socket is down `editor` is `null` everywhere. `editor.member` is `null` until the Member list has that id (the layer asks for the list once; a Guest never gets names). A claim by the signed-in Member is never shown as `editor`, also when it was made in another tab.
- To-dos: `useTodos()` is the server's order (`created_at`, then id). `todos.add` shows a draft with an id starting `pending:` until the server answers; the To-do then has its real id (do not key long-lived UI state on a `pending:` id). To-dos and the array keep their identity when a frame or reload brings nothing new. A frame or reload arriving while an edit is on its way does not undo it.
- `todos.*` reject locally, without a request: Guest → 403 `forbidden`; `setDone` on a To-do owned by someone else → 403 `forbidden`; an id not in `useTodos()` → 404 `not_found`; a text that is empty or over 500 characters after trimming → 400 `bad_request`. Texts are sent trimmed. Who may `edit` / `remove` (owner or creator) is left to the server: the edit shows, then is taken back with the 403. `todos.edit(id, {})` resolves without a request. `todos.reload()` for a Guest resolves without a request; otherwise it rejects with the ApiError.
- `board.open()` starts loading To-dos for Members without waiting for it (one more `GET /api/todos` per open); a failure there is silent and does not affect the Board. The list is cleared when the session ends or becomes a Guest's.
- Activity lines, beyond the contract's list: one line per Page per Activity, placed where the Page was first touched — "Added 3 blocks to the Page of X" / "Removed 2 blocks from the Page of X" for more than one, "Edited the Page of X" for rewriting or any mix of adding, removing and rewriting, "Reordered the Page of X" only when nothing else happened to it; a block that came back counts as added. A Source created and attached in one Activity reads only "Added Source T to X"; also "Added Source T" (not attached), "Removed Source T", "Brought back Source T", "Added and removed Source T". A Source without a title goes by its DOI, else its address, else "Untitled". Reordering a Page is not counted in "Moved N …".
- Merge texts, beyond the contract's list: a Source field Conflict has the Source's name as `entityTitle`, `headline` "Title / Authors / Year / Note / URL / DOI changed on both" and `canEdit: true`. Edit vs delete says "block" for a Block ("Delete the block", "Keep the block with its edits: text") and "Source" for a Source; for an Attachment `entityTitle` is "T on X", `headline` "Detached on <branch>, kept on <other>", and the sides read "Detach the Source" / "Keep the Source attached" / "Attach the Source again" / "Leave the Source detached". A block's `order` is layout: it never shows as an edit.
- Merge `auto`: `AutoLine.kind` has no value of its own for the new kinds, so a Page line, a new or edited Source and a new Attachment are `'Change'`: "Page of X · N blocks" (N: blocks of that Page added, removed, brought back or rewritten; one line per Card, where its first block stands in the plan), "Source T" (added, not attached by this plan), "Source T · year, DOI" (edited), "Source T · attached to X". `'Removed'`: "Source T", "Source T from X" (detached). `'Brought back'`: "Source T". In `autoSummary` these count as Changes, removed and brought back; a Page that is only reordered has no line and counts under "moved or resized". `layoutKept` does not count block order.
- `BoardPreview` has the same shape as before; its Cards carry the `blocks` / `sources` counts of that moment.
- `testing.ts` (the fake server): `todos`, `addTodo`, the four To-do routes, `todoFail`, `todoGate`, `todosFrame()`; `claim(member, card | null)` and `editingFrame()` for the soft lock.

## M5 — AI access tokens and Suggestions

Added to `index.ts` (types `AccessToken`, `Suggestion`, `SuggestionVM` in `types.ts`):

```ts
// ---- Suggestions of the open Branch ----
export function useSuggestions(): SuggestionVM[]        // pending first (newest first), then decided (newest decision first); [] for Guests / no Board. Stable identities
export const suggestions: {
  reload(): Promise<void>
  accept(id: string): Promise<{ sourceId?: string; cardId?: string }>   // builds the ops (new Source + Attachment, or attach `existingSource`, or the Connection) and calls POST …/accept. Rejects with ApiError: 409 `already_decided`, 409 `rejected` (the Card is gone), 400 `stale` locally when `stale`
  reject(id: string): Promise<void>
  reopen(id: string): Promise<void>                     // undo a reject
}

// ---- Access tokens for the AI tool layer (the signed-in Member's own) ----
export const tokens: {
  list(): Promise<AccessToken[]>
  create(name: string): Promise<{ token: AccessToken; secret: string }>   // secret is shown once
  remove(id: string): Promise<void>
}
export function toolEndpoint(): string                  // `${location.origin}/mcp`
```

Behaviour:

- Loaded by `board.open()` for Members (not awaited), kept fresh by the socket `suggestions` frame for the open Branch, refetched after a reconnect, cleared on Branch switch.
- `accept`/`reject`/`reopen` update the list optimistically and roll back on failure. The Changes of an accepted Suggestion reach the Board like any others (and are handed to it from the HTTP answer, deduplicated against the socket).
- `useBoard().connections` never contains a suggested Connection; the UI draws the preview itself from `SuggestionVM`.
- Guests: everything rejects locally with 403 `forbidden`; `useSuggestions()` stays `[]`.

## Notes from the M5 implementation

- Code: `suggestions.ts` (`suggestions`, `useSuggestions`, and the pure `toSuggestionVMs`, `sourceMeta`, `acceptOps`), `tokens.ts` (`tokens`, `toolEndpoint`), four events from `board-sync.ts` to the Suggestions (`internal.watch`: opened, reconnected, closed, the `suggestions` frame of the open Branch). The M5 types in `types.ts` are unchanged.
- `useSuggestions()` order: pending by `created_at`, newest first; then decided by `decided_at`, newest first; ties by id, descending. The server's order is not relied on.
- Identity: an item is the same object while its Suggestion and everything read from the Board for it (`title`, `meta`, `target`, `cards`, `stale`, `existingSource`) are the same, and the array is the same while every item is — a Card moving, presence, a Page edit, a frame or reload that brings nothing new do not re-render. Taking a decision back gives a new array (the items it did not touch are kept).
- Titles come from the live Cards of the open Branch, optimistic edits included. A Card without a title reads "Untitled"; a Card that is not live reads "Removed Card" ("Removed Card — Decoder", "for Card: Removed Card"). A Source without a title reads "Untitled Source". `target` of a Connection is "Board: <name of the open Branch>".
- `meta` of a Source: authors · year · identifier, a missing part left out (`''` when all are). Authors are split at commas: three or more read "<first> et al.", one or two are kept ("Kitaev, Preskill"). The identifier is `arXiv:<id>` for an `arxiv.org` / `www.` / `export.arxiv.org` address under `/abs/`, `/pdf/` (a `.pdf` ending dropped), `/html/`; the version stays as written (`arXiv:2007.14384v2`), old ids too (`arXiv:quant-ph/9512032`). Otherwise `doi:<doi>` from the `doi` field or a `doi.org` address, lower-cased as `normalizeDoi` gives it; otherwise the host of the address without a leading `www.`. An arXiv address wins over a DOI. `meta` of a Connection: its label, trimmed, else the kind word.
- `stale` is only about Cards: true when the Card of a suggested Source, or either Card of a suggested Connection, is not live — in every state, so a rejected Suggestion whose Card is gone can be reopened but not accepted. `cards` holds the live ones (a Connection from a Card to itself lists it once).
- `existingSource` uses the same matching as `page.findSource` (DOI first, then address; optimistic Sources count) and is set for pending and rejected Suggestions, never for an accepted one (the Source on the Branch is then the one it became).
- `suggestions.accept` posts, in one request: a new Source → `ops.createSource({ id, url, doi, title, authors, year })` (as the Suggestion gives them; `url` / `doi` trimmed, empty fields left out) and `ops.attach({ card, source: id })`; an `existingSource` → only `ops.attach` (also when that Source is already attached to the Card: a second Attachment shows as one, see M4); a Connection → `ops.createConnection({ from, to, kind, label })` with `kind` always written and the label trimmed. It resolves with `{ sourceId, cardId }` for a Source (`sourceId` is the new or the existing Source, `cardId` the Card it was attached to) and `{ cardId: from }` for a Connection.
- Optimism covers the list, not the Board: the Suggestion reads accepted at once (`decided_by` you, `decided_at` now), the Source or Connection appears on the Board when the answer or the socket brings its Changes, whichever is first; they are applied once and History hears of them once. `useBoard().pending` is not touched.
- `accept` / `reject` / `reopen` reject locally, without a request: Guest or signed out → 403 `forbidden`; no open Board → 400 `board_not_open`; an id not in `useSuggestions()` → 404 `not_found`; a state that does not allow it (accepting or rejecting a decided one, reopening one that is not rejected) → 409 `already_decided`; `accept` on a `stale` one → 400 `stale`. After a 409 `already_decided` from the server the list is fetched again, so it shows who decided. `reload()` rejects the same way for a Guest and without an open Board, and with the ApiError when the request fails.
- A frame or reload arriving while a decision is on its way does not undo it. An answer that arrives after a Branch switch, `board.close()` or the end of the session is dropped (the promise still settles).
- The list is loaded by `board.open()` for Members without waiting (one `GET /api/suggestions?branch=<id>` per open; a failure is silent and does not affect the Board), refetched when the socket is subscribed again after a drop, emptied the moment the Board closes or another Branch starts opening, and when the session ends, becomes a Guest's or changes hands. A `suggestions` frame naming another Branch is ignored.
- `tokens.*` keep nothing: `list()` asks every time. `create` sends the name trimmed and rejects locally with 400 `bad_request` when it is empty or over 60 characters; the limit of 10 is the server's (400 `bad_request`). All three reject locally with 403 `forbidden` for a Guest or a signed-out session. `toolEndpoint()` reads `location.origin` when called.
- `testing.ts` (the fake server): `tokens`, `secrets`, `tokenFail` and the three token routes; `suggestions`, `suggest(input, author?, branch?)` (adds one as the tool layer would), `suggestionsOf(branch?)`, `suggestionsFrame(branch?)`, the four Suggestion routes (accept applies the ops to the fake Board and sets `lastPostFrame`), `suggestionFail` (e.g. `{ status: 409, code: 'already_decided' }`, `{ status: 409, code: 'rejected' }`), `suggestionGate`. Like the core, it accepts an Attachment or Connection that points at a deleted Card.
