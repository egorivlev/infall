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
}

export type Invite = {
  id: string
  email: string
  role: Role
  access_until?: number
  expires_at: number
  created_by: string
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
  readOnly: boolean // true for Guests
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
  type: 'text' | 'visual' // unset on the wire means 'text'
  text: string // Markdown for 'text'; HTML/JavaScript source for 'visual'
  title: string // caption of a Visual; '' otherwise
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
}

export type AiModel = { id: string; name: string; context_length?: number }

/** Which AI the sidebar would use right now, and why not if none. */
export type AiSetup =
  | { provider: 'claude-code'; label: string; version?: string } // desktop app, `claude` installed
  | { provider: 'openrouter'; label: string; model: string } // a key and a model are set
  | {
      provider: 'none'
      reason: 'loading' | 'guest' | 'desktop_no_claude' | 'browser_no_key' | 'no_model' | 'server_off'
      desktop: boolean // running inside the desktop app
      openrouter: { enabled: boolean; key?: { last4: string; added_at: number }; model?: string }
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
