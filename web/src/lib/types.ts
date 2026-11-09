// Wire types shared with qoop-server. Source of truth: docs/specs/api.md.
// `erasableSyntaxOnly` is on: no enums, no parameter properties.

export type Role = 'admin' | 'member' | 'guest'

export type Member = {
  id: string
  name: string
  role: Role
  color: string
  email?: string
  access_until?: number
  /** M18: false for a Member who arrived as a name in a Workspace file and cannot sign in yet ("not signed in yet"). Absent (older servers) means true. */
  claimed?: boolean
}

export type Invite = {
  id: string
  email: string
  role: Role
  access_until?: number
  expires_at: number
  created_by: string
  /** M18: the unclaimed Member whose name the person who accepts takes over. */
  claims?: string
}

export type Value = 'Null' | { Float: number } | { Text: string } | { Ref: string }
export type Kind = 'Card' | 'Frame' | 'Connection' | 'Block' | 'Source' | 'Attachment'
export type Fields = Record<string, Value>

export type Op =
  | { Create: { entity: string; kind: Kind; fields: Fields } }
  | { Set: { entity: string; field: string; value: Value } }
  | { Delete: { entity: string } }
  | { Undelete: { entity: string } }

export type Moment = { branch: string; seq: number }
export type Origin =
  | 'Edit'
  | { Restore: { batch: string; to_seq: number } }
  | { Merge: { batch: string; source: Moment } }
export type Change = { id: string; author: string; at: number; op: Op; origin: Origin }
export type Entity = { kind: Kind; fields: Fields; deleted: boolean }

export type BranchInfo = {
  id: string
  name: string
  seq: number
  parent?: Moment
  created_by?: string
  created_at?: number
  checkpoints: number
}

export type Checkpoint = { name: string; moment: Moment; author: string; at: number }

export type BoardResponse = { branch: string; seq: number; entities: Record<string, Entity> }
export type ChangesResponse = { seq: number; changes: Change[] }

export type ServerFrame =
  | { type: 'subscribed'; branch: string; seq: number }
  | { type: 'changes'; branch: string; seq: number; changes: Change[] }
  | { type: 'presence'; branch: string; members: string[] }
  | { type: 'error'; code: string; message: string }
  | { type: 'checkpoint'; branch: string; checkpoint: Checkpoint }
  | { type: 'branches'; branches: BranchInfo[] }
  | { type: 'editing'; branch: string; editors: { card: string; member: string; since: number }[] }
  | { type: 'todos'; todos: Todo[] }
  | { type: 'suggestions'; branch: string; suggestions: Suggestion[] }
  | { type: 'refresh'; branch: string; seq: number } // Guests only: fetch the Board again
  | { type: 'comments'; card: string } // M18: the thread of that Card changed (Members only)
  | { type: 'for_you'; count: number } // M18: your unseen mentions are now `count` (to that Member only)
export type ClientFrame =
  | { type: 'subscribe'; branch: string; after: number }
  | { type: 'editing'; card: string | null }

export const STATUSES = ['idea', 'reading', 'understood', 'open_question', 'dead_end'] as const
export type Status = (typeof STATUSES)[number]
export const CONNECTION_KINDS = ['related', 'directed', 'contradicts'] as const
export type ConnectionKind = (typeof CONNECTION_KINDS)[number]

// ---- View models: what the UI renders. Live entities only. ----

export const CARD_W = 224
export const CARD_H = 132

export type CardVM = {
  id: string
  title: string
  summary: string
  status: Status // unset on the wire means 'idea'
  x: number
  y: number
  w: number // unset on the wire means CARD_W
  h: number // unset on the wire means CARD_H
  blocks: number // visible Blocks in its Page (M4)
  sources: number // visible Sources attached (M4)
}

export type FrameVM = { id: string; title: string; x: number; y: number; w: number; h: number }

export type ConnectionVM = {
  id: string
  from: string
  to: string
  label: string
  kind: ConnectionKind // unset on the wire means 'related'
}

export type BoardStatus = 'idle' | 'loading' | 'live' | 'reconnecting' | 'error'

export type BoardSnapshot = {
  status: BoardStatus
  error?: string
  branch?: BranchInfo
  seq: number
  cards: CardVM[] // live Cards, ordered by id
  frames: FrameVM[] // live Frames, ordered by id
  connections: ConnectionVM[] // live Connections whose two Cards are both live, ordered by id
  presence: Member[] // Members connected to this Branch (resolved from ids), self included
  pending: number // optimistic ops not yet confirmed by the server
  readOnly: boolean // true for Guests, and (M18) in a Workspace moved to a Team server
  moved?: true // M18: set only in a moved Workspace (read-only, but a Member: History still reads)
}

export type SessionSnapshot =
  | { status: 'loading' }
  | { status: 'signed_out' }
  | { status: 'signed_in'; member: Member }

// ---- M2: History ----

/**
 * One Member's consecutive Changes on a Branch, made close together in time, read as one entry.
 * A way of reading history, not something recorded. A Restore or a Merge is always its own Activity.
 */
export type Activity = {
  id: string // stable: id of its first Change
  author: string // Member id
  kind: 'edit' | 'restore' | 'merge'
  fromSeq: number // moment before its first Change
  toSeq: number // moment after its last Change — "restore to here" means this
  startedAt: number // unix ms
  endedAt: number
  count: number // Changes in it
  lines: string[] // plain-word summary, at most 6, e.g. "Added Card Surface code basics", "Status: Threshold → Understood"
  checkpoints: Checkpoint[] // Checkpoints whose moment falls in (fromSeq, toSeq]
}

/** The Board as it was at an earlier moment. Same view models as the live Board. */
export type BoardPreview = {
  seq: number
  at: number | null // time of the last Change before this moment; null at seq 0
  cards: CardVM[]
  frames: FrameVM[]
  connections: ConnectionVM[]
}

export type HistorySnapshot = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: string
  branch?: BranchInfo
  head: number // Changes on this Branch
  activities: Activity[] // oldest first
  checkpoints: Checkpoint[] // ordered by moment, then name; includes Checkpoints at seq 0
  preview: BoardPreview | null // set by history.preview(seq)
}

// ---- M3: Merge ----

export type Side = 'Source' | 'Target'
export type ConflictKey = { entity: string; field: string | null }
export type Conflict =
  | { Field: { entity: string; field: string; base: Value; source: Value; target: Value } }
  | { EditVsDelete: { entity: string; deleted_on: Side } }
export type Decision = 'TakeSource' | 'TakeTarget' | { Custom: Value }
export type MergePlan = { source: Moment; target: Moment; base: Moment; auto: Op[]; conflicts: Conflict[] }

/** A choice for one Conflict, as the UI makes it. `custom` only where `ConflictVM.canEdit`. */
export type Choice = 'source' | 'target' | { custom: string }

/** One side of a Conflict, ready to show. */
export type ConflictSide = {
  text: string // the value in plain words: the text itself, a Status label, a Card title for a Connection end, "(empty)"; for edit vs delete: "Delete the Card" / "Keep the Card with its edits: title, summary"
  status?: Status // set when the field is a Card's status, so the UI can draw the glyph
  author?: string // Member id who last changed it on that Branch, when known
  at?: number // when, unix ms
}

export type ConflictVM = {
  id: string // stable key: `${entity}:${field ?? ''}`
  key: ConflictKey
  type: 'field' | 'edit_vs_delete'
  entityKind: Kind
  entityTitle: string // "Threshold ≈ 1%"; a Connection reads "A → B"; untitled reads "Untitled"
  field: string | null // wire field name
  headline: string // "Title changed on both", "Status changed on both", "Deleted on main, edited on try-QEC", "Deleted on try-QEC, brought back on main"
  source: ConflictSide
  target: ConflictSide
  canEdit: boolean // true for text fields (title, summary, label): a hand-written value is allowed
  choice: Choice | null
}

/** One line of the "Merges automatically" list. */
export type AutoLine = {
  kind: 'Card added' | 'Frame added' | 'Connection added' | 'Change' | 'Removed' | 'Brought back'
  what: string // "Union-find vs MWPM benchmark", "Lattice surgery CNOT · summary", "A → B · calibrates"
}

export type MergeSnapshot = {
  status: 'idle' | 'loading' | 'ready' | 'applying' | 'merged' | 'error'
  error?: string // plain sentence
  errorCode?: string // 'not_parent_and_child' | 'not_found' | 'network' | …
  source?: BranchInfo
  target?: BranchInfo
  auto: AutoLine[]
  autoSummary: string // "9 Changes · 3 Cards added, 4 other Changes, 2 Connections added"; "Nothing to merge automatically"
  layoutKept: number // entities whose position/size differs between the Branches and stays as the target has it
  conflicts: ConflictVM[]
  decided: number
  nothingToMerge: boolean // no automatic Changes and no Conflicts
  checkpointName: string // default "Before merging <source>", made unique against the target's Checkpoints
  replanned: boolean // true after a Branch changed under the review and the plan was recomputed; cleared by the next decide()
  result?: { seq: number; changes: number; checkpoint?: Checkpoint } // when status is 'merged'
}

// ---- M4: Pages, Sources, To-dos ----

export type BlockVM = {
  id: string
  card: string
  type: 'text' | 'visual' | 'run' // unset on the wire means 'text'
  text: string // Markdown for 'text'; HTML/JavaScript source for 'visual'; code for 'run'
  title: string // caption of a Visual, name of a Run; '' otherwise
  run?: { result: RunResult | null; broken: boolean } // set for 'run' (M8); `broken`: a result is stored but cannot be read
  order: string
  ai?: { model: string; pinnedBy: string; pinnedAt: number; reviewedBy?: string } // set when pinned from an AI Conversation (M7)
}

export type SourceVM = {
  id: string
  url: string
  doi: string
  title: string
  authors: string
  year: string
  note: string
  cards: string[] // ids of live Cards it is attached to
}

/** A Source as attached to one Card. `attachment` is the Attachment entity to remove to detach. */
export type AttachedSource = SourceVM & { attachment: string }

/** Everything a Card expands into. */
export type PageVM = {
  card: CardVM | null // null when the Card is not live on this Board
  blocks: BlockVM[] // ascending `order`, ties by id
  sources: AttachedSource[] // ordered by year desc, then title
  connections: { id: string; other: CardVM; direction: 'out' | 'in' | 'none'; kind: ConnectionKind; label: string }[]
  editor: { member: Member | null; memberId: string; since: number } | null // someone ELSE holds the Page (soft lock); null if nobody or you
}

export type Todo = {
  id: string
  owner: string
  text: string
  done: boolean
  done_at?: number
  created_by: string
  created_at: number
  card?: { id: string; title: string; branch: string }
}

// ---- M5: AI access tokens and Suggestions ----

export type AccessToken = { id: string; name: string; created_at: number; last_used_at?: number }

export type Suggestion = {
  id: string
  branch: string
  kind: 'source' | 'connection'
  card?: string
  source?: { url?: string; doi?: string; title?: string; authors?: string; year?: string }
  connection?: { from: string; to: string; kind: ConnectionKind; label?: string }
  reason: string
  created_by: string
  model?: string
  created_at: number
  state: 'pending' | 'accepted' | 'rejected'
  decided_by?: string
  decided_at?: number
}

/** A Suggestion ready to show, resolved against the open Board. */
export type SuggestionVM = {
  suggestion: Suggestion
  title: string // Source: its title, or "Untitled Source"; Connection: "A → B" (directed), "A — B" otherwise
  meta: string // Source: "Wang et al. · 2021 · arXiv:2007.14384"; Connection: the label, or the kind word
  target: string // "for Card: <title>" or "Board: <branch name>"
  cards: string[] // ids of the Cards involved that are live on the open Board
  stale: boolean // a Card it needs is not live on this Branch any more: cannot be accepted
  existingSource?: string // Source id already on this Branch with the same DOI/URL: accepting attaches it
}

// ---- M7: the AI sidebar ----

export type AiEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'done'; model?: string; session?: string }
  | { type: 'error'; message: string }

/** The bridge the desktop app puts on `window.qoopDesktop` (docs/specs/desktop.md). Absent in a browser. */
export type QoopDesktop = {
  version: string
  claude: {
    status(): Promise<{ installed: boolean; version?: string }>
    send(
      request: { id: string; prompt: string; system: string; resume?: string; tools: { url: string; token: string } },
      onEvent: (event: AiEvent) => void,
    ): Promise<void>
    cancel(id: string): Promise<void>
  }
  runner?: QoopRunner // M8; absent in an older app
  /** M12: stops what is running, closes this window and shows the start screen. Absent in an older app: check before calling. */
  switchWorkspace?: () => Promise<void>
  /** M13: the system's save dialog, then the text written as UTF-8 (at most 20 MB); false when cancelled. Absent in an older app. */
  saveFile?: (file: { suggestedName: string; text: string }) => Promise<boolean>
  /** M18: the system's save dialog, then the bytes written as they are; false when cancelled. Absent in an older app. */
  saveBinaryFile?: (file: { suggestedName: string; bytes: Uint8Array }) => Promise<boolean>
  /** M18 (team-move.md, Contract C): the pending move to this origin — its Workspace name and file size — or null. Only on that origin. */
  moveHandover?: () => Promise<{ name: string; size: number } | null>
  /** M18: the pending move's Workspace file. */
  moveFile?: () => Promise<Uint8Array>
  /** M18: the import answered (`ok`) or failed; ok marks the Local Workspace Moved and forgets the move. */
  moveDone?: (result: { ok: boolean }) => Promise<void>
}

export type AiModel = { id: string; name: string; context_length?: number }

/** What the server holds for the Member's OpenRouter path (api.md §14); `enabled: false` when it is off or could not be asked. */
export type AiOpenRouter = { enabled: boolean; key?: { last4: string; added_at: number }; model?: string }

/**
 * Which AI the sidebar would use right now, and why not if none. Every variant says whether this is the desktop
 * app and what the OpenRouter settings are, so the settings screen can show and remove a stored key in any state.
 */
export type AiSetup = (
  | { provider: 'claude-code'; label: string; version?: string } // desktop app, `claude` installed
  | { provider: 'openrouter'; label: string; model: string } // a key and a model are set
  | { provider: 'none'; reason: 'loading' | 'guest' | 'desktop_no_claude' | 'browser_no_key' | 'no_model' | 'server_off' }
) & {
  desktop: boolean // running inside the desktop app
  openrouter: AiOpenRouter
}

export type AiScope = { branch: string; branchName: string; card?: { id: string; title: string } }

export type AiMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string // Markdown; grows while streaming
  at: number
  status: 'done' | 'streaming' | 'error' | 'stopped'
  error?: string // plain sentence when status is 'error'
  tools?: string[] // names of Qoop tools the AI used in this answer, in order
  model?: string // what answered (assistant messages)
  scope?: AiScope // what the Member was looking at when they asked (user messages)
  pinned?: { card: string; cardTitle: string; block: string }[] // where this answer was pinned
}

export type AiConversation = { id: string; title: string; createdAt: number; updatedAt: number; messages: AiMessage[] }

export type AiSnapshot = {
  setup: AiSetup
  conversations: { id: string; title: string; updatedAt: number }[] // newest first; this Member, this device
  current: AiConversation | null
  busy: boolean // an answer is streaming
}

// ---- M8: Runs and the Runner ----

/** The captured output of a Run's last execution: the JSON held in a Run Block's `result` (api.md §15). */
export type RunResult = {
  v: 1
  by: string // Member id
  at: number // unix ms, when it ended
  code_sha256: string
  exit: number | null // null: stopped or killed
  stopped?: boolean
  duration_ms: number
  output: string
  output_truncated?: boolean
  figures: { png: string }[] // base64 PNG
  env?: { python?: string; packages?: Record<string, string>; os?: string; arch?: string }
}

export type RunEvent =
  | { type: 'approval' }
  | { type: 'started' }
  | { type: 'output'; text: string }
  | {
      type: 'done'
      exit: number | null
      stopped: boolean
      duration_ms: number
      code_sha256: string
      output: string
      output_truncated: boolean
      figures: { png: string }[]
      env: { python?: string; packages?: Record<string, string>; os?: string; arch?: string }
    }
  | { type: 'error'; reason: 'declined' | 'no_python' | 'busy' | 'failed'; message: string }
  | ({ type: 'stats' } & RunUsage) // M9; about once a second while the process runs; never sent by an M8 app

/** What a Run is using right now, as the Runner measured it (docs/specs/desktop.md, M9). */
export type RunUsage = {
  cpu_percent: number // of the Run's own processes; 100 = one core fully busy
  cores: number // logical cores of this computer
  memory_bytes: number // resident memory of the Run's own processes
  memory_total_bytes: number // of this computer
  processes: number // how many processes the Run has
  gpu?: { percent: number; name?: string } // of the whole computer, not only the Run; absent when it cannot be read
  step?: string // what the code says it is doing, one line, ≤ 120 characters
  progress?: { done: number; total: number } // total > 0, 0 ≤ done ≤ total
}

/** The latest usage of the Run in flight, with what the lib derives from the samples so far. */
export type RunStats = RunUsage & {
  at: number // unix ms, when this sample arrived
  peak_memory_bytes: number // the largest memory_bytes seen in this execution
  eta_ms?: number // estimated time left; only while `progress` is moving
}

/** `window.qoopDesktop.runner` (docs/specs/desktop.md, M8). */
export type QoopRunner = {
  status(): Promise<{ python?: { path: string; version: string }; folder?: string }>
  configure(): Promise<void>
  run(request: { id: string; code: string; title: string }, onEvent: (event: RunEvent) => void): Promise<void>
  cancel(id: string): Promise<void>
}

/** Whether this device can execute Runs, and why not. */
export type RunnerSetup =
  | { available: false; reason: 'loading' | 'browser' | 'guest' | 'old_app' }
  | { available: true; python?: { path: string; version: string }; folder?: string }

/** The one execution in flight in this window. */
export type RunLive = {
  block: string
  branch: string // id of the Branch it was started on
  state: 'approval' | 'running' | 'saving' // waiting for the Member in the app's window / executing / recording the result
  output: string // live output so far
  startedAt?: number // set once it is running
  stats?: RunStats // M9: the latest sample; absent before the first one and with an M8 app
}

/** How the last execution in this window ended, until dismissed or the next one starts. */
export type RunOutcome = {
  block: string
  branch: string
  status: 'recorded' | 'declined' | 'failed' | 'unsaved'
  message?: string // plain sentence for 'failed' and 'unsaved'
  unsaved?: RunResult // the result that could not be recorded; `runs.saveAgain()` retries
}

export type RunsSnapshot = { runner: RunnerSetup; live: RunLive | null; last: RunOutcome | null }

// ---- M12: Local Workspaces ----

/** Where this Workspace is kept (docs/specs/local.md, Contract B): on a team's server, or on this computer only. */
export type WorkspaceKind = 'team' | 'local'

/**
 * `GET /api/workspace`. `preset`: the Preset a Local Workspace was made from ("tutorial", "blank", …); null for a Team Workspace.
 * M18: `empty` — a Team server with nothing in it yet (only `main`, no Changes, Checkpoints, To-dos or Comments);
 * `readOnly` — this copy was moved to a Team server and refuses every write (403 `moved`); `movedTo` — where it went,
 * when the server says so (`moved_to`, NOT in Contract B: null when absent).
 */
export type WorkspaceInfo = { kind: WorkspaceKind; preset: string | null; empty: boolean; readOnly: boolean; movedTo: string | null }

/** What the UI knows about the Workspace. Until it is known (`status` not `'ready'`) it reads as a Team Workspace. */
export type WorkspaceSnapshot = WorkspaceInfo & { status: 'idle' | 'loading' | 'ready' }

// ---- M13: Look up (docs/specs/portability.md, Contract B) and saving a file in the desktop app (Contract D) ----

/** What Look up asks the server for: one DOI or one arXiv id. */
export type LookupQuery = { doi: string } | { arxiv: string }

/** The registry's details for a Source. `authors` in the Source field's form; '' where the registry has nothing. */
export type LookupResult = { title: string; authors: string; year: string; doi: string | null; url: string | null }

// ---- M15b: the Branch Graph (docs/specs/branch-graph.md; wire: docs/specs/api.md §18) ----

/** One Activity of a Branch as `GET /api/graph` gives it: the Changes `(from_seq, to_seq]`, without their contents. */
export type GraphActivity = {
  kind: 'edit' | 'merge' | 'restore'
  author: string // Member id
  from_seq: number
  to_seq: number
  started_at: number // unix ms, its first Change
  ended_at: number // its last Change
  source?: Moment // kind 'merge': the moment of the other Branch it brought in
  to?: number // kind 'restore': the moment of this Branch it returned to
}

export type GraphCheckpoint = { name: string; seq: number; author: string; at: number }

/** The shape of one Branch. `activities` are in order and cover `(0, seq]`. */
export type GraphBranch = {
  id: string
  name: string
  seq: number
  parent?: Moment // absent for main
  created_by?: string
  created_at?: number
  checkpoints: GraphCheckpoint[] // by seq, then name; seq 0 = at its own start
  activities: GraphActivity[]
}

/** `GET /api/graph`: main first, then by when each Branch was started. */
export type GraphResponse = { branches: GraphBranch[] }

/** A place on the drawn graph: a row (0 = the top, the newest) and a column (0 = main's). */
export type GraphPoint = { row: number; column: number }

/**
 * One row of the graph: one Activity (a dot), or — the last row — the start of the Workspace, main at seq 0.
 * Rows are newest first: by the time each Activity ended, never against a Branch's own order.
 */
export type GraphRow = {
  key: string // `<branch id>:<from_seq>:<to_seq>`, 'start' for the start row: the same while the Activity is unchanged
  kind: 'edit' | 'merge' | 'restore' | 'start'
  branch: string // Branch id (main for the start row)
  column: number
  index: number // in its Branch's `activities`; -1 for the start row
  activity: GraphActivity | null // null for the start row
  moment: Moment // where a Branch started from this dot starts: right after the Activity; the start row: main at 0
  checkpoints: GraphCheckpoint[] // the ◆ on this dot: its Branch's Checkpoints at `moment.seq` (start row: main's at 0)
  forks: string[] // ids of the Branches whose line leaves this dot (started from a moment it holds)
  source?: GraphPoint & { branch: string; seq: number } // kind 'merge': the dot holding the merged moment; absent when that Branch is unknown
}

/** One Branch's line. Its column is held from `forkRow` (bottom) up to `topRow`; no other line uses it in between. */
export type GraphLane = {
  branch: string // id
  name: string
  column: number
  parent?: string // parent Branch id; absent for main
  forkRow: number // where the line starts: the parent's dot holding the fork moment (main: the start row)
  forkExact: boolean // the fork moment is exactly the end of that dot (false: started partway through it)
  lastRow: number // its newest dot; forkRow when it has no Changes
  topRow: number // lastRow, or the row of the Merge into its parent that took its last dot (`endsIn`)
  endsIn?: number // that Merge's row: the line visibly ends in the parent there
  rows: number[] // the rows of its dots, top first
  startCheckpoints: GraphCheckpoint[] // Checkpoints at its own start (seq 0): drawn at (forkRow, column), its fork point
}

export type GraphEdge =
  // the line leaving the parent: from the parent's dot to the child's column on the same row
  | { kind: 'fork'; branch: string; from: GraphPoint; to: GraphPoint }
  // a Merge: from the dot holding the source moment to the Merge's dot (`branch` is the Branch merged into)
  | { kind: 'merge'; branch: string; from: GraphPoint; to: GraphPoint }

/** `layoutGraph(response)`: a pure function of the `/api/graph` response. */
export type GraphLayout = {
  columns: number // how many columns the graph needs: the most Branches being worked on at once
  rows: GraphRow[] // newest first; the last one is the start row
  lanes: GraphLane[] // in the response's order, main first
  edges: GraphEdge[] // forks (in lane order), then Merges (top first)
}

/** What the Branch Graph store holds. `layout` is `layoutGraph(graph)`, recomputed whenever `graph` changes. */
export type GraphSnapshot = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: string
  graph: GraphResponse | null // kept while a refetch runs and when one fails
  layout: GraphLayout | null
}

/** One line of "Show every Change": a Change in plain words. */
export type GraphChangeLine = { id: string; author: string; at: number; line: string }

// ---- M18: moving a Workspace (docs/specs/team-move.md, Contract B) ----

/** `POST /api/workspace/import`'s answer: every Member the file brought, and the name the importing Admin's work had. */
export type ImportResult = { members: { id: string; name: string; claimed: boolean }[]; you_were: string }

/** `GET /api/workspace/export`: the Workspace file and the name the server gave it. */
export type ExportedFile = { name: string; bytes: Uint8Array }

// ---- M18: Comments and For you (outside versioning, like To-dos) ----

export type Comment = {
  id: string
  author: string // Member id
  text: string // at most 10 000 characters; inline Markdown and math as a Page's text block
  mentions: string[] // Member ids
  created_at: number
  edited_at: number | null
}

/** The thread of one Card. `card` need not be live on any Branch: a thread outlives its Card. */
export type ThreadSnapshot = {
  card: string
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: string
  resolved: boolean
  comments: Comment[] // oldest first
}

/** `GET /api/comments/counts`, per Card with a thread. */
export type CommentCount = { open: number; resolved: boolean }

export type ForYouItem = { comment: string; card: string; author: string; at: number; seen: boolean }

export type ForYouSnapshot = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  items: ForYouItem[] // newest first, at most 200
  unseen: number
}
