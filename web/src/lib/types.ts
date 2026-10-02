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
export type Kind = 'Card' | 'Frame' | 'Connection'
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
}

export type BoardResponse = { branch: string; seq: number; entities: Record<string, Entity> }
export type ChangesResponse = { seq: number; changes: Change[] }

export type ServerFrame =
  | { type: 'subscribed'; branch: string; seq: number }
  | { type: 'changes'; branch: string; seq: number; changes: Change[] }
  | { type: 'presence'; branch: string; members: string[] }
  | { type: 'error'; code: string; message: string }
export type ClientFrame = { type: 'subscribe'; branch: string; after: number }

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
