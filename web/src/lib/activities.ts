// Pure History logic: replaying Changes, grouping them into Activities, and wording them.
import type { Entities } from './board-state'
import { applyOps } from './board-state'
import type { Activity, Change, Checkpoint, Entity, Fields, Kind, Moment, Op, Status } from './types'
import { STATUSES } from './types'

export const ACTIVITY_GAP_MS = 10 * 60 * 1000
export const MAX_LINES = 6

export type GroupOptions = {
  gapMs?: number // longest pause between neighbouring Edits of one Activity; default 10 minutes
  maxLines?: number // default 6
  startSeq?: number // seq of the moment `baseEntities` describes, i.e. how many Changes precede `changes[0]`; default 0
}

export const STATUS_WORDS: Record<Status, string> = {
  idea: 'Idea',
  reading: 'Reading',
  understood: 'Understood',
  open_question: 'Open question',
  dead_end: 'Dead end',
}

const ARROW = '→'

/** Applies ops in order. A server log always applies; if one op does not, it is skipped, not fatal. */
export function replay(entities: Entities, ops: readonly Op[]): Entities {
  if (ops.length === 0) return entities
  const all = applyOps(entities, ops)
  if (all.ok) return all.entities
  let current = entities
  for (const op of ops) {
    const r = applyOps(current, [op])
    if (r.ok) current = r.entities
  }
  return current
}

function entityOf(op: Op): string {
  if ('Create' in op) return op.Create.entity
  if ('Set' in op) return op.Set.entity
  if ('Delete' in op) return op.Delete.entity
  return op.Undelete.entity
}

function text(fields: Fields, name: string): string {
  const v = fields[name]
  return typeof v === 'object' && 'Text' in v ? v.Text : ''
}

function ref(fields: Fields, name: string): string {
  const v = fields[name]
  return typeof v === 'object' && 'Ref' in v ? v.Ref : ''
}

function sameValue(a: Fields, b: Fields, name: string): boolean {
  return JSON.stringify(a[name] ?? null) === JSON.stringify(b[name] ?? null)
}

export function titleOf(e: Entity | undefined): string {
  const t = e ? text(e.fields, 'title').trim() : ''
  return t === '' ? 'Untitled' : t
}

function statusOf(e: Entity): Status {
  const s = text(e.fields, 'status')
  return (STATUSES as readonly string[]).includes(s) ? (s as Status) : 'idea'
}

function kindOf(e: Entity): string {
  return text(e.fields, 'kind') || 'related'
}

// "A → B" for a Connection, by the titles its two Cards have in `world`.
export function ends(e: Entity, world: Entities): string {
  return `${titleOf(world[ref(e.fields, 'from')])} ${ARROW} ${titleOf(world[ref(e.fields, 'to')])}`
}

function named(e: Entity, world: Entities): string {
  return e.kind === 'Connection' ? `Connection ${ends(e, world)}` : `${e.kind} ${titleOf(e)}`
}

/** What a Source goes by: its title, else its DOI, else its address. */
export function sourceName(e: Entity | undefined): string {
  if (!e) return 'Untitled'
  for (const name of ['title', 'doi', 'url']) {
    const t = text(e.fields, name).trim()
    if (t !== '') return t
  }
  return 'Untitled'
}

const SOURCE_FIELDS = ['url', 'doi', 'title', 'authors', 'year', 'note']

export function isVisual(e: Entity | undefined): boolean {
  return e !== undefined && e.kind === 'Block' && text(e.fields, 'type') === 'visual'
}

/** What a Visual goes by: "Visual <title>", or "Untitled Visual". */
export function visualName(e: Entity | undefined): string {
  const t = e ? text(e.fields, 'title').trim() : ''
  return t === '' ? 'Untitled Visual' : `Visual ${t}`
}

export function isRun(e: Entity | undefined): boolean {
  return e !== undefined && e.kind === 'Block' && text(e.fields, 'type') === 'run'
}

/** What a Run goes by: "Run <name>", or "Untitled Run". */
export function runName(e: Entity | undefined): string {
  const t = e ? text(e.fields, 'title').trim() : ''
  return t === '' ? 'Untitled Run' : `Run ${t}`
}

// A Simulation — a Visual or a Run — is spoken of by its own name, in a line of its own.
const isSimulation = (e: Entity | undefined): boolean => isVisual(e) || isRun(e)
const simulationName = (e: Entity): string => (isRun(e) ? runName(e) : visualName(e))

type Laid = 'Card' | 'Frame' | 'Connection' // the kinds that sit on the Board itself
type PageEdits = { added: number; removed: number; edited: number; reordered: number; pinned: number; reviewed: number }

// What a run did to one block, or to one Attachment: it appeared, it went, or (a block) it changed.
function fate(was: Entity | undefined, now: Entity): 'added' | 'removed' | 'changed' | 'none' {
  if (!was || was.deleted) return now.deleted ? 'none' : 'added'
  return now.deleted ? 'removed' : 'changed'
}

// A Visual is edited when its source, its title, or what it is changed; a Run when its code, its name, what it is,
// or (M19b) the language or environment it names.
function visualEdited(was: Entity, now: Entity): boolean {
  return ['text', 'title', 'type', 'lang', 'env'].some((f) => !sameValue(was.fields, now.fields, f))
}

// A Run ends a run of Changes with another result than it began with: executed, or its output cleared.
function resultChanged(was: Entity | undefined, now: Entity): boolean {
  return isRun(now) && !sameValue(was?.fields ?? {}, now.fields, 'result')
}

// A Block pinned from an AI Conversation says who pinned it; it is reviewed once a Member put their id on it.
const isPinned = (e: Entity): boolean => text(e.fields, 'ai_pinned_by') !== ''
const isReviewed = (e: Entity): boolean => text(e.fields, 'ai_reviewed_by') !== ''

function answers(n: number): string {
  return n === 1 ? 'an AI answer' : `${n} AI answers`
}

function blocks(n: number): string {
  return n === 1 ? 'a block' : `${n} blocks`
}

// One line for everything a run did to the Page of one Card, or none when nothing lasting happened.
function pageLine(e: PageEdits, card: string): string | null {
  if (e.edited > 0 || (e.added > 0 && e.removed > 0)) return `Edited the Page of ${card}`
  if (e.added > 0) return `Added ${blocks(e.added)} to the Page of ${card}`
  if (e.removed > 0) return `Removed ${blocks(e.removed)} from the Page of ${card}`
  return e.reordered > 0 ? `Reordered the Page of ${card}` : null
}

// M19: which PDF a Source has (its `pdf` hash; the name, size and pages go with it and say nothing of their own).
function pdfLine(was: string, now: string, source: string): string | null {
  if (was === now) return null
  if (!was) return `Attached a PDF to ${source}`
  if (!now) return `Removed the PDF from ${source}`
  return `Replaced the PDF of ${source}`
}

function plural(n: number, kind: Kind): string {
  return `${n} ${kind}${n === 1 ? '' : 's'}`
}

function cut(lines: string[], max: number): string[] {
  if (lines.length <= max) return lines
  const keep = Math.max(max - 1, 0)
  return [...lines.slice(0, keep), `and ${lines.length - keep} more`]
}

/**
 * Plain-word summary of what a run of Changes did, as the net difference between the Board before and after.
 * Entities are named by the title they had at the end of the run (a removed one: when it was removed).
 */
export function describeChanges(
  before: Entities,
  after: Entities,
  changes: readonly Change[],
  maxLines = MAX_LINES,
): string[] {
  const touched: string[] = []
  const seen = new Set<string>()
  for (const c of changes) {
    const id = entityOf(c.op)
    if (!seen.has(id)) {
      seen.add(id)
      touched.push(id)
    }
  }
  const lines: string[] = []
  const laidOut: Record<Laid, number> = { Card: 0, Frame: 0, Connection: 0 }
  let moved = false
  let resized = false
  // Pages are read as a whole: what happened to all the blocks of one Card makes one line.
  const pages = new Map<string, PageEdits>()
  const attachedNow = new Set<string>() // Sources that this run attached to a Card
  for (const id of touched) {
    const was = before[id]
    const now = after[id]
    if (!now) continue
    if (now.kind === 'Block') {
      const card = ref(now.fields, 'card')
      let e = pages.get(card)
      if (!e) pages.set(card, (e = { added: 0, removed: 0, edited: 0, reordered: 0, pinned: 0, reviewed: 0 }))
      const what = fate(was, now)
      if (isSimulation(now)) {
        // A Visual or a Run has a line of its own; only its place in the Page is the Page's business.
        if (what === 'changed' && was && !visualEdited(was, now) && !resultChanged(was, now) && !sameValue(was.fields, now.fields, 'order')) e.reordered++
      } else if (what === 'added') {
        // Pinned in this run: said in its own words. One that only came back reads as any block does.
        if (!was && isPinned(now)) e.pinned++
        else e.added++
      } else if (what === 'removed') e.removed++
      else if (what === 'changed' && was) {
        if (isPinned(now) && isReviewed(now) && !isReviewed(was)) e.reviewed++
        if (!sameValue(was.fields, now.fields, 'text') || !sameValue(was.fields, now.fields, 'type')) e.edited++
        else if (!sameValue(was.fields, now.fields, 'order')) e.reordered++
      }
    } else if (now.kind === 'Attachment' && fate(was, now) === 'added') {
      attachedNow.add(ref(now.fields, 'source'))
    }
  }
  const pagesSaid = new Set<string>()
  for (const id of touched) {
    const was = before[id]
    const now = after[id]
    if (!now) continue
    if (now.kind === 'Block') {
      const card = ref(now.fields, 'card')
      if (isSimulation(now)) {
        const what = fate(was, now)
        const name = simulationName(now)
        const page = `the Page of ${titleOf(after[card])}`
        if (what === 'added') lines.push(`Added ${name} to ${page}`)
        else if (what === 'removed') lines.push(`Removed ${name} from ${page}`)
        else if (what === 'changed' && was && visualEdited(was, now)) lines.push(`Edited ${name} in ${page}`)
        // An execution is said beside whatever else happened to the Run: who executed it is what a Run records.
        if (what !== 'removed' && what !== 'none' && resultChanged(was, now)) {
          lines.push('result' in now.fields ? `Executed ${name} in ${page}` : `Cleared the output of ${name} in ${page}`)
        }
      }
      if (pagesSaid.has(card)) continue
      pagesSaid.add(card)
      const edits = pages.get(card)!
      const title = titleOf(after[card])
      if (edits.pinned > 0) lines.push(`Pinned ${answers(edits.pinned)} to the Page of ${title}`)
      if (edits.reviewed > 0) lines.push(`Marked ${answers(edits.reviewed)} as reviewed in the Page of ${title}`)
      const line = pageLine(edits, title)
      if (line) lines.push(line)
      continue
    }
    if (now.kind === 'Attachment') {
      const what = fate(was, now)
      const source = sourceName(after[ref(now.fields, 'source')])
      const card = titleOf(after[ref(now.fields, 'card')])
      if (what === 'added') {
        lines.push(`Added Source ${source} to ${card}`)
        // A new Source that came with its PDF: said here, after the line that names it.
        const s = ref(now.fields, 'source')
        const pdf = !before[s] && after[s] && !after[s].deleted ? pdfLine('', text(after[s].fields, 'pdf'), source) : null
        if (pdf && !lines.includes(pdf)) lines.push(pdf)
      } else if (what === 'removed') lines.push(`Removed Source ${source} from ${card}`)
      continue
    }
    if (now.kind === 'Source') {
      const name = sourceName(now)
      if (!was) {
        if (now.deleted) lines.push(`Added and removed Source ${name}`)
        else if (!attachedNow.has(id)) {
          // Attached at once: the Attachment's line says it, and its PDF after it.
          lines.push(`Added Source ${name}`)
          const pdf = pdfLine('', text(now.fields, 'pdf'), name)
          if (pdf) lines.push(pdf)
        }
      } else if (now.deleted) {
        if (!was.deleted) lines.push(`Removed Source ${name}`)
      } else if (was.deleted) lines.push(`Brought back Source ${name}`)
      else {
        if (SOURCE_FIELDS.some((f) => !sameValue(was.fields, now.fields, f))) lines.push(`Edited Source ${name}`)
        const pdf = pdfLine(text(was.fields, 'pdf'), text(now.fields, 'pdf'), name)
        if (pdf) lines.push(pdf)
      }
      continue
    }
    if (!was) {
      const what = now.kind === 'Connection' ? ends(now, after) : named(now, after)
      if (now.deleted) lines.push(`Added and removed ${named(now, after)}`)
      else lines.push(now.kind === 'Connection' ? `Connected ${what}` : `Added ${what}`)
      continue
    }
    if (now.deleted) {
      if (!was.deleted) {
        lines.push(now.kind === 'Connection' ? `Disconnected ${ends(now, after)}` : `Removed ${named(now, after)}`)
      }
      continue
    }
    const start = lines.length
    if (was.deleted) {
      lines.push(now.kind === 'Connection' ? `Reconnected ${ends(now, after)}` : `Brought back ${named(now, after)}`)
    }
    if (now.kind === 'Connection') {
      if (!sameValue(was.fields, now.fields, 'from') || !sameValue(was.fields, now.fields, 'to')) {
        lines.push(`Reconnected ${ends(now, after)}`)
      }
      const label = text(now.fields, 'label').trim()
      if (text(was.fields, 'label').trim() !== label) {
        lines.push(label === '' ? `Removed the label of ${ends(now, after)}` : `Labelled ${ends(now, after)}: ${label}`)
      }
      if (kindOf(was) !== kindOf(now)) lines.push(`Marked ${ends(now, after)} as ${kindOf(now)}`)
    } else {
      if (titleOf(was) !== titleOf(now)) lines.push(`Renamed ${now.kind} ${titleOf(was)} ${ARROW} ${titleOf(now)}`)
      if (now.kind === 'Card') {
        if (statusOf(was) !== statusOf(now)) lines.push(`Status: ${titleOf(now)} ${ARROW} ${STATUS_WORDS[statusOf(now)]}`)
        if (text(was.fields, 'summary') !== text(now.fields, 'summary')) {
          lines.push(`Edited the summary of ${titleOf(now)}`)
        }
      }
    }
    if (lines.length > start) continue
    const position = !sameValue(was.fields, now.fields, 'x') || !sameValue(was.fields, now.fields, 'y')
    const size = !sameValue(was.fields, now.fields, 'w') || !sameValue(was.fields, now.fields, 'h')
    if (position || size) {
      laidOut[now.kind]++
      moved = moved || position
      resized = resized || size
    }
  }
  const counts = (['Card', 'Frame', 'Connection'] as const).filter((k) => laidOut[k] > 0).map((k) => plural(laidOut[k], k))
  if (counts.length > 0) {
    const verb = moved && resized ? 'Moved and resized' : resized ? 'Resized' : 'Moved'
    lines.push(`${verb} ${counts.join(' and ')}`)
  }
  if (lines.length === 0) lines.push('No lasting changes')
  return cut(lines, maxLines)
}

type RunKind = Activity['kind']

function batchOf(c: Change): { kind: RunKind; batch: string | null } {
  if (c.origin === 'Edit') return { kind: 'edit', batch: null }
  if ('Restore' in c.origin) return { kind: 'restore', batch: c.origin.Restore.batch }
  return { kind: 'merge', batch: c.origin.Merge.batch }
}

/** One Activity without its words: which Changes it covers, `(fromSeq, toSeq]`, and what kind it is. */
export type ActivityShape = {
  id: string // id of its first Change
  kind: RunKind
  author: string
  fromSeq: number
  toSeq: number
  startedAt: number
  endedAt: number
  source?: Moment // a Merge: the moment it brought in
  to?: number // a Restore: the moment of its Branch it returned to
}

/**
 * The grouping rule of Activities without their words. The server has the same rule (`infall_core::activities`,
 * behind `GET /api/graph`); both are checked against the shared fixture `docs/specs/branch-graph-activities.json`.
 *
 * - Consecutive `Edit` Changes by one author with no pause over `gapMs` between neighbours are one Activity
 *   (a clock that went backwards is no pause).
 * - Consecutive Changes of one Restore (or Merge) batch are one Activity of that kind, whatever surrounds them.
 * - A Checkpoint always ends the Activity it falls in: no Activity reaches across a moment in `cuts` (the seqs of
 *   the Branch's Checkpoints, counted from the Branch's start as `startSeq` is).
 */
export function groupShapes(
  changes: readonly Change[],
  cuts: Iterable<number>,
  options: { gapMs?: number; startSeq?: number } = {},
): ActivityShape[] {
  const gapMs = options.gapMs ?? ACTIVITY_GAP_MS
  const startSeq = options.startSeq ?? 0
  const cut = new Set(cuts)
  const out: ActivityShape[] = []
  let i = 0
  while (i < changes.length) {
    const first = changes[i]!
    const head = batchOf(first)
    let j = i + 1
    while (j < changes.length) {
      if (cut.has(startSeq + j)) break
      const c = changes[j]!
      const b = batchOf(c)
      if (b.kind !== head.kind) break
      if (head.kind === 'edit') {
        if (c.author !== first.author || c.at - changes[j - 1]!.at > gapMs) break
      } else if (b.batch !== head.batch) break
      j++
    }
    const shape: ActivityShape = {
      id: first.id,
      kind: head.kind,
      author: first.author,
      fromSeq: startSeq + i,
      toSeq: startSeq + j,
      startedAt: first.at,
      endedAt: changes[j - 1]!.at,
    }
    const origin = first.origin
    if (origin !== 'Edit' && 'Merge' in origin) shape.source = origin.Merge.source
    if (origin !== 'Edit' && 'Restore' in origin) shape.to = origin.Restore.to_seq
    out.push(shape)
    i = j
  }
  return out
}

/**
 * Reads a Branch's Changes as Activities, oldest first, by the rule of `groupShapes`: a Checkpoint ends the
 * Activity it falls in.
 *
 * - `baseEntities` is the Board before `changes[0]` (the Branch at seq 0 unless `startSeq` says otherwise);
 *   it is replayed along the way so that `lines` use the titles of that moment.
 * - `checkpoints` are attached to the Activity whose `(fromSeq, toSeq]` holds their moment, which is its end.
 */
export function groupActivities(
  changes: readonly Change[],
  checkpoints: readonly Checkpoint[],
  baseEntities: Entities,
  options: GroupOptions = {},
): Activity[] {
  const maxLines = options.maxLines ?? MAX_LINES
  const startSeq = options.startSeq ?? 0
  const shapes = groupShapes(
    changes,
    checkpoints.map((c) => c.moment.seq),
    { gapMs: options.gapMs, startSeq },
  )
  let world = baseEntities
  return shapes.map((shape) => {
    const run = changes.slice(shape.fromSeq - startSeq, shape.toSeq - startSeq)
    const before = world
    world = replay(world, run.map((c) => c.op))
    const lines =
      shape.kind === 'restore'
        ? ['Restored to an earlier moment']
        : shape.kind === 'merge'
          ? ['Merged from another Branch']
          : describeChanges(before, world, run, maxLines)
    return {
      id: shape.id,
      author: shape.author,
      kind: shape.kind,
      fromSeq: shape.fromSeq,
      toSeq: shape.toSeq,
      startedAt: shape.startedAt,
      endedAt: shape.endedAt,
      count: run.length,
      lines,
      checkpoints: checkpoints.filter((c) => c.moment.seq > shape.fromSeq && c.moment.seq <= shape.toSeq).sort(byMoment),
    }
  })
}

export function byMoment(a: Checkpoint, b: Checkpoint): number {
  return a.moment.seq - b.moment.seq || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}
