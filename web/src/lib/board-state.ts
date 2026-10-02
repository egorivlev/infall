// Pure Board logic: applying operations (core.md sections 1 and 2) and building view models.
import type { CardVM, ConnectionVM, Entity, Fields, FrameVM, Op, Value } from './types'
import { CARD_H, CARD_W, CONNECTION_KINDS, STATUSES } from './types'

export type Entities = Record<string, Entity>

export type RejectionCode = 'exists' | 'missing' | 'deleted' | 'not_deleted' | 'invalid'
export type Rejection = { code: RejectionCode; entity: string; message: string }
export type ApplyResult = { ok: true; entities: Entities } | { ok: false; rejection: Rejection }

function reject(code: RejectionCode, entity: string, message: string): Rejection {
  return { code, entity, message }
}

function floatError(value: Value): boolean {
  return typeof value === 'object' && 'Float' in value && !Number.isFinite(value.Float)
}

function isCardRef(work: Entities, value: Value | undefined): boolean {
  return typeof value === 'object' && 'Ref' in value && work[value.Ref]?.kind === 'Card'
}

// Applies one op to a working map the caller owns. Returns a rejection, or null on success.
function applyInto(work: Entities, op: Op): Rejection | null {
  if ('Create' in op) {
    const { entity, kind, fields } = op.Create
    if (entity in work) return reject('exists', entity, 'An entity with this id already exists.')
    const kept: Fields = {}
    for (const [name, value] of Object.entries(fields)) {
      if (floatError(value)) return reject('invalid', entity, `Field ${name} must be a finite number.`)
      if (value !== 'Null') kept[name] = value
    }
    if (kind === 'Connection' && !(isCardRef(work, kept.from) && isCardRef(work, kept.to))) {
      return reject('invalid', entity, 'A Connection must join two existing Cards.')
    }
    work[entity] = { kind, fields: kept, deleted: false }
    return null
  }
  if ('Set' in op) {
    const { entity, field, value } = op.Set
    const current = work[entity]
    if (!current) return reject('missing', entity, 'No such entity.')
    if (current.deleted) return reject('deleted', entity, 'The entity is deleted.')
    if (floatError(value)) return reject('invalid', entity, `Field ${field} must be a finite number.`)
    const fields = { ...current.fields }
    if (value === 'Null') delete fields[field]
    else fields[field] = value
    work[entity] = { ...current, fields }
    return null
  }
  if ('Delete' in op) {
    const { entity } = op.Delete
    const current = work[entity]
    if (!current) return reject('missing', entity, 'No such entity.')
    if (current.deleted) return reject('deleted', entity, 'The entity is already deleted.')
    work[entity] = { ...current, deleted: true }
    return null
  }
  const { entity } = op.Undelete
  const current = work[entity]
  if (!current) return reject('missing', entity, 'No such entity.')
  if (!current.deleted) return reject('not_deleted', entity, 'The entity is not deleted.')
  work[entity] = { ...current, deleted: false }
  return null
}

// All-or-nothing: either every op applies and a new map is returned, or the first rejection.
export function applyOps(entities: Entities, ops: readonly Op[]): ApplyResult {
  const work: Entities = { ...entities }
  for (const op of ops) {
    const rejection = applyInto(work, op)
    if (rejection) return { ok: false, rejection }
  }
  return { ok: true, entities: work }
}

export function applyOp(entities: Entities, op: Op): ApplyResult {
  return applyOps(entities, [op])
}

// ---- view models ----

export type SnapshotParts = { cards: CardVM[]; frames: FrameVM[]; connections: ConnectionVM[] }

function text(fields: Fields, name: string): string {
  const v = fields[name]
  return typeof v === 'object' && 'Text' in v ? v.Text : ''
}

function float(fields: Fields, name: string, fallback: number): number {
  const v = fields[name]
  return typeof v === 'object' && 'Float' in v ? v.Float : fallback
}

function ref(fields: Fields, name: string): string {
  const v = fields[name]
  return typeof v === 'object' && 'Ref' in v ? v.Ref : ''
}

function oneOf<T extends string>(allowed: readonly T[], value: string, fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function shallowEqual(a: object, b: object): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  const rb = b as Record<string, unknown>
  const ra = a as Record<string, unknown>
  return ka.every((k) => Object.is(ra[k], rb[k]))
}

// Reuses previous item objects (and the previous array) when nothing changed, so identity is stable.
function reuse<T extends { id: string }>(prev: readonly T[] | undefined, next: T[]): T[] {
  if (!prev) return next
  const old = new Map(prev.map((item) => [item.id, item]))
  const merged = next.map((item) => {
    const before = old.get(item.id)
    return before && shallowEqual(before, item) ? before : item
  })
  const same = merged.length === prev.length && merged.every((item, i) => item === prev[i])
  return same ? (prev as T[]) : merged
}

export function toSnapshotParts(entities: Entities, prev?: SnapshotParts): SnapshotParts {
  const cards: CardVM[] = []
  const frames: FrameVM[] = []
  const connections: ConnectionVM[] = []
  const ids = Object.keys(entities).sort()
  const liveCard = (id: string) => {
    const e = entities[id]
    return e !== undefined && e.kind === 'Card' && !e.deleted
  }
  for (const id of ids) {
    const e = entities[id]
    if (!e || e.deleted) continue
    const f = e.fields
    if (e.kind === 'Card') {
      cards.push({
        id,
        title: text(f, 'title'),
        summary: text(f, 'summary'),
        status: oneOf(STATUSES, text(f, 'status'), 'idea'),
        x: float(f, 'x', 0),
        y: float(f, 'y', 0),
        w: float(f, 'w', CARD_W),
        h: float(f, 'h', CARD_H),
      })
    } else if (e.kind === 'Frame') {
      frames.push({
        id,
        title: text(f, 'title'),
        x: float(f, 'x', 0),
        y: float(f, 'y', 0),
        w: float(f, 'w', 0),
        h: float(f, 'h', 0),
      })
    } else {
      const from = ref(f, 'from')
      const to = ref(f, 'to')
      if (!liveCard(from) || !liveCard(to)) continue
      connections.push({
        id,
        from,
        to,
        label: text(f, 'label'),
        kind: oneOf(CONNECTION_KINDS, text(f, 'kind'), 'related'),
      })
    }
  }
  cards.sort(byId)
  frames.sort(byId)
  connections.sort(byId)
  return {
    cards: reuse(prev?.cards, cards),
    frames: reuse(prev?.frames, frames),
    connections: reuse(prev?.connections, connections),
  }
}
