// Undo (docs/specs/undo.md): the pure core. What a gesture did as parts, how each part is taken back and done
// again, the check against what happened on the Branch since (decision 5), the list rules, and the words.
// The store around it — the lists per Branch, the Changes it has seen, sending — is undo-store.ts.
import { describeChanges } from './activities'
import type { Entities } from './board-state'
import type { Entity, Fields, Op, Origin, Value } from './types'

/** Steps kept per Branch (decision 9). */
export const UNDO_DEPTH = 100
/** The mark of a part whose batch the server has not confirmed yet: nothing is "since" it. */
export const PENDING = Number.MAX_SAFE_INTEGER

export const NOTHING_TO_UNDO = 'Nothing to undo. To go further back, use History.'
export const NOTHING_TO_REDO = 'Nothing to redo.'

/**
 * One thing a gesture did, with what it takes to take it back and to do it again. `mark` is the Branch's seq right
 * after the batch that last did it in that direction: the Changes after it are the ones "since".
 * - `set`: a field went from `before` to `after` (`'Null'` for unset);
 * - `create` / `undelete`: a thing appeared (taking it back deletes it; doing it again brings it back);
 * - `delete`: a thing went; `had` lists the Connections a deleted Card had at that moment (decision 10).
 */
export type Part =
  | { kind: 'set'; entity: string; field: string; before: Value; after: Value; mark: number }
  | { kind: 'create'; entity: string; mark: number }
  | { kind: 'delete'; entity: string; mark: number; had?: string[] }
  | { kind: 'undelete'; entity: string; mark: number }

/** A Change of the Branch as the check needs it: where it stands, who made it, what it did. */
export type Logged = { seq: number; id: string; author: string; op: Op; origin: Origin }

export type Direction = 'undo' | 'redo'

export function entityOf(op: Op): string {
  if ('Create' in op) return op.Create.entity
  if ('Set' in op) return op.Set.entity
  if ('Delete' in op) return op.Delete.entity
  return op.Undelete.entity
}

export function sameValue(a: Value | undefined, b: Value | undefined): boolean {
  return JSON.stringify(a ?? 'Null') === JSON.stringify(b ?? 'Null')
}

const REF_FIELDS = ['card', 'from', 'to', 'source'] as const

function refsIn(fields: Fields | undefined): string[] {
  if (!fields) return []
  const out: string[] = []
  for (const name of REF_FIELDS) {
    const v = fields[name]
    if (typeof v === 'object' && 'Ref' in v) out.push(v.Ref)
  }
  return out
}

function ref(fields: Fields, name: string): string {
  const v = fields[name]
  return typeof v === 'object' && 'Ref' in v ? v.Ref : ''
}

// ---- what a batch did ----

/**
 * A small view over a Board that a run of ops is applied to without copying the Board: what changed is kept aside.
 * The ops are trusted to apply (the sync layer checked them); one that does not is skipped.
 */
class Overlay {
  private readonly base: Entities
  private readonly local = new Map<string, Entity>()
  constructor(base: Entities) {
    this.base = base
  }
  get(id: string): Entity | undefined {
    return this.local.has(id) ? this.local.get(id) : this.base[id]
  }
  live(id: string): boolean {
    const e = this.get(id)
    return e !== undefined && !e.deleted
  }
  changed(): Map<string, Entity> {
    return this.local
  }
  /** Applies one op; false when it would not apply (and nothing changes). */
  apply(op: Op): boolean {
    if ('Create' in op) {
      const { entity, kind, fields } = op.Create
      if (this.get(entity)) return false
      const kept: Fields = {}
      for (const [k, v] of Object.entries(fields)) if (v !== 'Null') kept[k] = v
      this.local.set(entity, { kind, fields: kept, deleted: false })
      return true
    }
    if ('Set' in op) {
      const { entity, field, value } = op.Set
      const e = this.get(entity)
      if (!e || e.deleted) return false
      const fields = { ...e.fields }
      if (value === 'Null') delete fields[field]
      else fields[field] = value
      this.local.set(entity, { ...e, fields })
      return true
    }
    if ('Delete' in op) {
      const e = this.get(op.Delete.entity)
      if (!e || e.deleted) return false
      this.local.set(op.Delete.entity, { ...e, deleted: true })
      return true
    }
    const e = this.get(op.Undelete.entity)
    if (!e || !e.deleted) return false
    this.local.set(op.Undelete.entity, { ...e, deleted: false })
    return true
  }
}

/** The Connections shown on a Card on this Board: live, with both their Cards live. */
function connectionsShown(view: Overlay, card: string, index: () => Map<string, string[]>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const candidates = [...(index().get(card) ?? [])]
  for (const [id, e] of view.changed()) if (e.kind === 'Connection') candidates.push(id)
  for (const id of candidates) {
    if (seen.has(id)) continue
    seen.add(id)
    const e = view.get(id)
    if (!e || e.deleted || e.kind !== 'Connection') continue
    const from = ref(e.fields, 'from')
    const to = ref(e.fields, 'to')
    if (from !== card && to !== card) continue
    if (view.live(from) && view.live(to)) out.push(id)
  }
  return out.sort()
}

/**
 * The parts of one batch of ops sent on `before` (the Board as it was just before it, optimistic edits included).
 * Parts come in the order of the ops; several ops on the same field are one part. All marks are `mark`.
 */
export function partsOf(before: Entities, ops: readonly Op[], mark = PENDING): Part[] {
  const view = new Overlay(before)
  let byCard: Map<string, string[]> | null = null
  const index = () => {
    if (byCard) return byCard
    byCard = new Map()
    for (const [id, e] of Object.entries(before)) {
      if (e.kind !== 'Connection') continue
      for (const end of [ref(e.fields, 'from'), ref(e.fields, 'to')]) {
        const list = byCard.get(end)
        if (list) list.push(id)
        else byCard.set(end, [id])
      }
    }
    return byCard
  }
  const parts: Part[] = []
  for (const op of ops) {
    const entity = entityOf(op)
    const was = view.get(entity)
    let part: Part
    if ('Create' in op) part = { kind: 'create', entity, mark }
    else if ('Set' in op) part = { kind: 'set', entity, field: op.Set.field, before: was?.fields[op.Set.field] ?? 'Null', after: op.Set.value, mark }
    else if ('Delete' in op) {
      part = { kind: 'delete', entity, mark }
      if (was?.kind === 'Card') part.had = connectionsShown(view, entity, index)
    } else part = { kind: 'undelete', entity, mark }
    if (view.apply(op)) parts.push(part)
  }
  return mergeParts([], parts, { subsume: true })
}

/**
 * `added` (a later batch of the same gesture) folded into `into`: a field set twice is one part (the first
 * `before`, the last `after` and mark); what is created and deleted again in one gesture leaves nothing. Parts whose
 * field ends as it began are dropped. With `subsume` (ops of one batch, where nobody can come in between) a Set on
 * something just created is part of creating it; across batches it stays a part of its own, since someone may have
 * written that field in between (see `planStep`).
 */
export function mergeParts(into: readonly Part[], added: readonly Part[], options: { subsume?: boolean } = {}): Part[] {
  const out: (Part | null)[] = []
  const byEntity = new Map<string, number[]>() // every index a thing has in `out`
  const created = new Set<string>()
  const deleted = new Map<string, number>()
  const undeleted = new Map<string, number>()
  const sets = new Map<string, number>() // `${entity}\u0000${field}` → index
  const put = (p: Part) => {
    const i = out.length
    out.push(p)
    const at = byEntity.get(p.entity)
    if (at) at.push(i)
    else byEntity.set(p.entity, [i])
    if (p.kind === 'create') created.add(p.entity)
    else if (p.kind === 'delete') deleted.set(p.entity, i)
    else if (p.kind === 'undelete') undeleted.set(p.entity, i)
    else sets.set(`${p.entity}\u0000${p.field}`, i)
  }
  for (const p of into) put(p)
  for (const p of added) {
    if (p.kind === 'set') {
      if (options.subsume && created.has(p.entity)) continue // the creation brings it back as it is
      const i = sets.get(`${p.entity}\u0000${p.field}`)
      const q = i === undefined ? null : out[i]
      if (i === undefined || !q || q.kind !== 'set') put(p)
      else out[i] = { ...q, after: p.after, mark: p.mark }
    } else if (p.kind === 'delete') {
      if (created.has(p.entity)) {
        // Made and removed within one gesture: nothing of it is left to take back.
        for (const i of byEntity.get(p.entity) ?? []) out[i] = null
        byEntity.delete(p.entity)
        created.delete(p.entity)
        for (const k of [...sets.keys()]) if (k.startsWith(`${p.entity}\u0000`)) sets.delete(k)
      } else if (undeleted.has(p.entity)) {
        out[undeleted.get(p.entity)!] = null
        undeleted.delete(p.entity)
      } else put(p)
    } else if (p.kind === 'undelete') {
      if (deleted.has(p.entity)) {
        out[deleted.get(p.entity)!] = null
        deleted.delete(p.entity)
      } else put(p)
    } else put(p)
  }
  return out.filter((p): p is Part => p !== null && (p.kind !== 'set' || !sameValue(p.before, p.after)))
}

// ---- taking a part back, doing it again ----

export function inverseOf(p: Part): Op {
  switch (p.kind) {
    case 'set':
      return { Set: { entity: p.entity, field: p.field, value: p.before } }
    case 'delete':
      return { Undelete: { entity: p.entity } }
    default:
      return { Delete: { entity: p.entity } }
  }
}

export function forwardOf(p: Part): Op {
  switch (p.kind) {
    case 'set':
      return { Set: { entity: p.entity, field: p.field, value: p.after } }
    case 'delete':
      return { Delete: { entity: p.entity } }
    default:
      return { Undelete: { entity: p.entity } }
  }
}

// ---- decision 5: touched since ----

type Indexed = { byEntity: Map<string, Logged[]>; byRef: Map<string, Logged[]> }

function indexLog(log: readonly Logged[], entities: Entities): Indexed {
  const byEntity = new Map<string, Logged[]>()
  const byRef = new Map<string, Logged[]>()
  const push = (m: Map<string, Logged[]>, k: string, c: Logged) => {
    const list = m.get(k)
    if (list) list.push(c)
    else m.set(k, [c])
  }
  for (const c of log) {
    const id = entityOf(c.op)
    push(byEntity, id, c)
    const fields = 'Create' in c.op ? c.op.Create.fields : entities[id]?.fields
    for (const r of new Set(refsIn(fields))) push(byRef, r, c)
  }
  return { byEntity, byRef }
}

/**
 * Whether Change `c` touches part `p` (decision 5): for a field, it set the same field of the same thing; for a
 * thing the part made appear, any Change to it or to something belonging to it (a block of its Page, its
 * Connections, its Attachments — whatever refers to it); for a thing the part deleted, bringing it back.
 * `entities` (the Board now, deleted things included) says what a Change's thing belongs to.
 * A field of a thing someone deleted is not "touched": it is left because it can no longer be set (see `planStep`),
 * and if they bring the thing back, the field is as I left it and can be undone.
 */
export function touches(c: Logged, p: Part, entities: Entities): boolean {
  const id = entityOf(c.op)
  if (id === p.entity) {
    if (p.kind === 'set') return 'Set' in c.op && c.op.Set.field === p.field
    return true
  }
  if (p.kind !== 'create' && p.kind !== 'undelete') return false
  const fields = 'Create' in c.op ? c.op.Create.fields : entities[id]?.fields
  return refsIn(fields).includes(p.entity)
}

function touchedBy(p: Part, ix: Indexed, ours: (id: string) => boolean, entities: Entities): string[] {
  const candidates = p.kind === 'create' || p.kind === 'undelete' ? [...(ix.byEntity.get(p.entity) ?? []), ...(ix.byRef.get(p.entity) ?? [])] : (ix.byEntity.get(p.entity) ?? [])
  const by: string[] = []
  for (const c of candidates) {
    if (c.seq <= p.mark || ours(c.id) || by.includes(c.author)) continue
    if (touches(c, p, entities)) by.push(c.author)
  }
  return by
}

/** What one Undo or Redo of a step does. */
export type Plan = {
  ops: Op[] // to send, in this order
  applied: Part[] // the part each op is for, in the same order
  done: Part[] // the parts it takes back (does again), in the step's order
  left: Part[] // the parts left as they are, in the step's order
  by: string[] // who changed the parts left since (Member ids, first met first); empty when they are only gone
  things: number // how many things the parts left are about
  cut: number // Connections of a Card brought back that stay away: the Card at their other end is gone (decision 10)
}

/**
 * Plans an Undo (or Redo) of a step's `parts` against the Changes the Branch had since (`log`, any order) on the
 * Board as it is now (`entities`, deleted things included, optimistic edits included). `ours(id)` is true for the
 * Changes of this list itself — its steps and earlier Undos/Redos — which never block: undoing in order handles
 * them. Everyone else's Changes, and the Member's own from outside the list, do. A part that would no longer apply
 * (its thing is gone) is left too.
 */
export function planStep(direction: Direction, parts: readonly Part[], log: readonly Logged[], ours: (id: string) => boolean, entities: Entities): Plan {
  const ix = indexLog(log, entities)
  const view = new Overlay(entities)
  const authors = new Map<Part, string[]>()
  for (const p of parts) authors.set(p, touchedBy(p, ix, ours, entities))
  // Fields of a thing this step made, set by a later batch of it (the title typed into a new Card): they go with the
  // thing — taken back with it, or kept with it — unless they wrote over someone else's value in between, which then
  // comes back.
  const made = new Map<string, Part>()
  for (const p of parts) if (p.kind === 'create') made.set(p.entity, p)
  const overwrote = (p: Extract<Part, { kind: 'set' }>, maker: Part) =>
    (ix.byEntity.get(p.entity) ?? []).some((c) => c.seq > maker.mark && c.seq < p.mark && !ours(c.id) && touches(c, p, entities))
  const order = direction === 'undo' ? [...parts].reverse() : [...parts]
  const ops: Op[] = []
  const applied: Part[] = []
  const sent = new Set<Part>()
  const done = new Set<Part>()
  const by: string[] = []
  const blame = (list: readonly string[]) => {
    for (const a of list) if (!by.includes(a)) by.push(a)
  }
  for (const p of order) {
    const own = authors.get(p)!
    const maker = p.kind === 'set' ? made.get(p.entity) : undefined
    if (p.kind === 'set' && maker) {
      const makerBy = authors.get(maker)!
      if (own.length === 0 && makerBy.length === 0) {
        done.add(p) // goes and comes back with the thing itself
        continue
      }
      if (direction === 'redo' || own.length > 0 || !overwrote(p, maker)) {
        blame(own.length > 0 ? own : makerBy)
        continue
      }
    } else if (own.length > 0) {
      blame(own)
      continue
    }
    const op = direction === 'undo' ? inverseOf(p) : forwardOf(p)
    if (!view.apply(op)) continue
    ops.push(op)
    applied.push(p)
    sent.add(p)
    done.add(p)
  }
  // A thing's fields that were to go with it are not done when the thing itself could not be.
  for (const p of [...done]) {
    const maker = p.kind === 'set' ? made.get(p.entity) : undefined
    if (maker && !sent.has(p) && !done.has(maker)) done.delete(p)
  }
  let cut = 0
  if (direction === 'undo') {
    for (const p of done) {
      if (p.kind !== 'delete' || !p.had) continue
      for (const k of p.had) {
        const e = view.get(k)
        if (!e || e.deleted) continue // removed by someone since: theirs, not counted
        const other = ref(e.fields, 'from') === p.entity ? ref(e.fields, 'to') : ref(e.fields, 'from')
        if (!view.live(other)) cut++
      }
    }
  }
  const left = parts.filter((p) => !done.has(p))
  return { ops, applied, done: parts.filter((p) => done.has(p)), left, by, things: new Set(left.map((p) => p.entity)).size, cut }
}

/** The parts of a step after an Undo or Redo of it went through: the ones done, marked with that batch. */
export function remark(parts: readonly Part[], mark: number): Part[] {
  return parts.map((p) => ({ ...p, mark }))
}

// ---- the list ----

/** A list of steps, newest first. */
export type Lists<S> = { undo: S[]; redo: S[] }

/** A new step: on top, the 101st from the bottom is gone, nothing can be redone any more (decision 7). */
export function pushStep<S>(l: Lists<S>, step: S, depth = UNDO_DEPTH): Lists<S> {
  return { undo: [step, ...l.undo].slice(0, depth), redo: [] }
}

/** True when a Change ends the lists of its Branch: a Merge or a Restore landed (decision 4). */
export function endsLists(origin: Origin): boolean {
  return origin !== 'Edit'
}

// ---- words ----

const VERBS: [string, string][] = [
  ['Added and removed ', 'Add and remove '],
  ['Moved and resized ', 'Move and resize '],
  ['Removed the label of ', 'Remove the label of '],
  ['Removed Card ', 'Delete Card '],
  ['Removed Frame ', 'Delete Frame '],
  ['Added ', 'Add '],
  ['Removed ', 'Remove '],
  ['Moved ', 'Move '],
  ['Resized ', 'Resize '],
  ['Renamed ', 'Rename '],
  ['Connected ', 'Connect '],
  ['Disconnected ', 'Disconnect '],
  ['Reconnected ', 'Reconnect '],
  ['Labelled ', 'Label '],
  ['Marked ', 'Mark '],
  ['Edited ', 'Edit '],
  ['Reordered ', 'Reorder '],
  ['Brought back ', 'Bring back '],
  ['Pinned ', 'Pin '],
  ['Cleared ', 'Clear '],
  ['Executed ', 'Execute '],
]

/** A History line as the name of a step: "Moved 3 Cards" → "Move 3 Cards", "Removed Card Axions" → "Delete Card Axions". */
export function imperative(line: string): string {
  for (const [past, now] of VERBS) if (line.startsWith(past)) return now + line.slice(past.length)
  return line // "Status: Axions → Understood" reads as it is
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`
}

function list(parts: string[]): string {
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? '')
}

// "Delete 2 Cards and 1 Connection" when every line is one of these and there are several.
function counted(lines: string[], verb: string, patterns: [RegExp, string][]): string | null {
  const n = new Map<string, number>()
  for (const line of lines) {
    const hit = patterns.find(([re]) => re.test(line))
    if (!hit) return null
    n.set(hit[1], (n.get(hit[1]) ?? 0) + 1)
  }
  const parts = patterns.map(([, kind]) => kind).filter((k, i, all) => all.indexOf(k) === i && n.has(k)).map((k) => plural(n.get(k)!, k))
  return `${verb} ${list(parts)}`
}

/**
 * The name of a step in History's words (decision 11): `before` is the Board as the gesture found it (only the
 * things it touched matter), `after` as it left it. One line reads as History's line in the present tense; several
 * deletions or additions are counted ("Delete 2 Cards and 1 Connection"); anything else is its first line "and N more".
 */
export function labelFor(before: Entities, after: Entities, ops: readonly Op[]): string {
  const changes = ops.map((op) => ({ id: '', author: '', at: 0, op, origin: 'Edit' as const }))
  const lines = describeChanges(before, after, changes, Number.POSITIVE_INFINITY).filter((l) => l !== 'No lasting changes')
  if (lines.length === 0) return 'Edit'
  if (lines.length === 1) return imperative(lines[0]!)
  return (
    counted(lines, 'Delete', [
      [/^Removed Card /, 'Card'],
      [/^Removed Frame /, 'Frame'],
      [/^Disconnected /, 'Connection'],
    ]) ??
    counted(lines, 'Add', [
      [/^Added Card /, 'Card'],
      [/^Added Frame /, 'Frame'],
      [/^Connected /, 'Connection'],
    ]) ??
    `${imperative(lines[0]!)} and ${lines.length - 1} more`
  )
}

/** "Ana", "Ana and Ben", "Ana, Ben and you". `me` reads "you"; a name nobody knows reads "Someone". */
export function names(ids: readonly string[], nameOf: (id: string) => string | undefined, me: string): string {
  const words = ids.map((id) => (id === me ? 'you' : (nameOf(id) ?? 'Someone')))
  const unique = words.filter((w, i) => words.indexOf(w) === i)
  // "you" goes last: "Ana and you".
  unique.sort((a, b) => (a === 'you' ? 1 : 0) - (b === 'you' ? 1 : 0))
  return list(unique)
}

/**
 * What a short note says after an Undo or Redo (decision 5 and 11):
 * "Undid Move 3 Cards." · "Undid Move 3 Cards. 1 left as it is — Ana changed it since." · "Not undone — Ana changed this since."
 */
export function noteFor(direction: Direction, label: string, plan: Plan, nameOf: (id: string) => string | undefined, me: string): string {
  const who = plan.by.length > 0 ? names(plan.by, nameOf, me) : null
  if (plan.done.length === 0) {
    const not = direction === 'undo' ? 'Not undone' : 'Not redone'
    return who ? `${not} — ${who} changed this since.` : `${not} — it was removed since.`
  }
  let note = `${direction === 'undo' ? 'Undid' : 'Redid'} ${label}.`
  if (plan.left.length > 0) {
    const n = plan.things
    const one = n === 1
    note += who
      ? ` ${n} left as ${one ? 'it is' : 'they are'} — ${who} changed ${one ? 'it' : 'them'} since.`
      : ` ${n} left as ${one ? 'it is' : 'they are'} — ${one ? 'it was' : 'they were'} removed since.`
  }
  if (plan.cut > 0) {
    note += ` ${plural(plan.cut, 'Connection')} left out — the Card at ${plan.cut === 1 ? 'its' : 'their'} other end is gone.`
  }
  return note
}
