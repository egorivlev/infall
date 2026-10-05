// Pure Merge logic: turning a plan and the two head Boards into what the review shows, and choices into Decisions.
import { ends, STATUS_WORDS, titleOf } from './activities'
import type { Entities } from './board-state'
import type {
  AutoLine,
  BranchInfo,
  Change,
  Choice,
  Conflict,
  ConflictKey,
  ConflictSide,
  ConflictVM,
  Decision,
  Entity,
  Fields,
  Kind,
  MergePlan,
  Op,
  Status,
  Value,
} from './types'
import { STATUSES } from './types'

/** Everything the view models are built from. `base` is the Board at the plan's base, when it was loaded. */
export type MergeWorld = {
  sourceName: string
  targetName: string
  source: Entities // head Board of the source, deleted entities included
  target: Entities
  base: Entities | null
  sourceChanges: readonly Change[] // the source Branch's own Changes up to the planned moment
  targetChanges: readonly Change[]
}

/** A Conflict ready to show (no choice yet), and a print of what it is about: a choice fits while the print stays. */
export type BuiltConflict = { vm: ConflictVM; print: string }

const EMPTY = '(empty)'
const LAYOUT = ['x', 'y', 'w', 'h']
const EDITABLE = ['title', 'summary', 'label']

// Connections have no layout; an unknown field is content, as in the core.
function isLayout(kind: Kind, field: string): boolean {
  return kind !== 'Connection' && LAYOUT.includes(field)
}

function same(a: Value | undefined, b: Value | undefined): boolean {
  return JSON.stringify(a ?? 'Null') === JSON.stringify(b ?? 'Null')
}

function fieldNames(a: Fields, b: Fields): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
}

function contentOf(e: Entity): Fields {
  const out: Fields = {}
  for (const name of Object.keys(e.fields).sort()) if (!isLayout(e.kind, name)) out[name] = e.fields[name]!
  return out
}

function capital(s: string): string {
  return s === '' ? s : s[0]!.toUpperCase() + s.slice(1)
}

// The word a field goes by: a Connection's `from` / `to` read "start" / "end".
function fieldWord(kind: Kind, field: string): string {
  if (kind === 'Connection' && field === 'from') return 'start'
  if (kind === 'Connection' && field === 'to') return 'end'
  return field
}

function titleIn(world: Entities, id: string): string {
  const e = world[id]
  if (!e) return 'Untitled'
  return e.kind === 'Connection' ? ends(e, world) : titleOf(e)
}

function statusOf(value: Value): Status {
  const s = typeof value === 'object' && 'Text' in value ? value.Text : ''
  return (STATUSES as readonly string[]).includes(s) ? (s as Status) : 'idea'
}

// One side of a field Conflict in plain words. `world` names the Cards a Connection end refers to.
function describeValue(kind: Kind, field: string, value: Value, world: Entities): ConflictSide {
  if (kind === 'Card' && field === 'status') {
    const status = statusOf(value)
    return { text: STATUS_WORDS[status], status }
  }
  if (value === 'Null') return { text: kind === 'Connection' && field === 'kind' ? 'Related' : EMPTY }
  if ('Ref' in value) return { text: titleIn(world, value.Ref) }
  if ('Float' in value) return { text: String(value.Float) }
  if (kind === 'Connection' && field === 'kind') return { text: capital(value.Text) }
  return { text: value.Text.trim() === '' ? EMPTY : value.Text }
}

function entityOf(op: Op): string {
  if ('Create' in op) return op.Create.entity
  if ('Set' in op) return op.Set.entity
  if ('Delete' in op) return op.Delete.entity
  return op.Undelete.entity
}

// Who last did something matching `touches` on a Branch, and when. `from`: Changes before it are not the Branch's own.
function lastTouch(changes: readonly Change[], from: number, touches: (op: Op) => boolean): Pick<ConflictSide, 'author' | 'at'> {
  for (let i = changes.length - 1; i >= from; i--) {
    const c = changes[i]!
    if (touches(c.op)) return { author: c.author, at: c.at }
  }
  return {}
}

function touchesField(entity: string, field: string) {
  return (op: Op) =>
    ('Set' in op && op.Set.entity === entity && op.Set.field === field) ||
    ('Create' in op && op.Create.entity === entity && field in op.Create.fields)
}

function touchesContent(entity: string, kind: Kind) {
  return (op: Op) =>
    ('Set' in op && op.Set.entity === entity && !isLayout(kind, op.Set.field)) ||
    ('Create' in op && op.Create.entity === entity) ||
    ('Undelete' in op && op.Undelete.entity === entity)
}

export function conflictKey(c: Conflict): ConflictKey {
  return 'Field' in c
    ? { entity: c.Field.entity, field: c.Field.field }
    : { entity: c.EditVsDelete.entity, field: null }
}

export function conflictId(key: ConflictKey): string {
  return `${key.entity}:${key.field ?? ''}`
}

/** The plan's Conflicts as view models (with `choice: null`), in the plan's order. */
export function buildConflicts(plan: MergePlan, w: MergeWorld): BuiltConflict[] {
  // Titles come from the source Board; the target Board for what is only there. Each side names Cards its own way.
  const sourceWorld: Entities = { ...w.target, ...w.source }
  const targetWorld: Entities = { ...w.source, ...w.target }
  // Changes before the base on the Branch the base lies on are shared history, not that Branch's own doing.
  const sourceFrom = plan.base.branch === plan.source.branch ? plan.base.seq : 0
  const targetFrom = plan.base.branch === plan.target.branch ? plan.base.seq : 0

  return plan.conflicts.map((c): BuiltConflict => {
    const key = conflictKey(c)
    const entity = sourceWorld[key.entity]
    const entityKind: Kind = entity?.kind ?? 'Card'
    const common = {
      id: conflictId(key),
      key,
      entityKind,
      entityTitle: titleIn(sourceWorld, key.entity),
      field: key.field,
      choice: null,
    }
    if ('Field' in c) {
      const { field, source, target } = c.Field
      const touches = touchesField(key.entity, field)
      return {
        vm: {
          ...common,
          type: 'field',
          headline: `${capital(fieldWord(entityKind, field))} changed on both`,
          source: { ...describeValue(entityKind, field, source, sourceWorld), ...lastTouch(w.sourceChanges, sourceFrom, touches) },
          target: { ...describeValue(entityKind, field, target, targetWorld), ...lastTouch(w.targetChanges, targetFrom, touches) },
          canEdit: EDITABLE.includes(field),
        },
        print: JSON.stringify([source, target]),
      }
    }
    const deletedOnSource = c.EditVsDelete.deleted_on === 'Source'
    const live = (deletedOnSource ? w.target : w.source)[key.entity]
    const was = w.base?.[key.entity]
    // What the live side changed since the two Branches agreed. Without the base Board we only know that it did.
    const edits =
      live && was && !was.deleted
        ? fieldNames(was.fields, live.fields).filter((n) => !isLayout(live.kind, n) && !same(was.fields[n], live.fields[n]))
        : []
    const edited = w.base === null || edits.length > 0
    const withEdits = edits.length > 0 ? ` with its edits: ${edits.map((n) => fieldWord(entityKind, n)).join(', ')}` : ''
    const deleted = (changes: readonly Change[], from: number) =>
      lastTouch(changes, from, (op) => 'Delete' in op && op.Delete.entity === key.entity)
    const kept = (changes: readonly Change[], from: number) =>
      lastTouch(changes, from, touchesContent(key.entity, entityKind))
    const [gone, other] = deletedOnSource ? [w.sourceName, w.targetName] : [w.targetName, w.sourceName]
    return {
      vm: {
        ...common,
        type: 'edit_vs_delete',
        headline: `Deleted on ${gone}, ${edited ? 'edited' : 'kept'} on ${other}`,
        source: deletedOnSource
          ? { text: `Delete the ${entityKind}`, ...deleted(w.sourceChanges, sourceFrom) }
          : { text: `Bring back the ${entityKind}${withEdits}`, ...kept(w.sourceChanges, sourceFrom) },
        target: deletedOnSource
          ? { text: `Keep the ${entityKind}${withEdits}`, ...kept(w.targetChanges, targetFrom) }
          : { text: `Leave the ${entityKind} deleted`, ...deleted(w.targetChanges, targetFrom) },
        canEdit: false,
      },
      print: JSON.stringify([c.EditVsDelete.deleted_on, live ? contentOf(live) : null]),
    }
  })
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * The "Merges automatically" list and its one-line summary.
 *
 * One line per entity, in the plan's order: added (named by its title; a Connection "A → B · label"), changed
 * ("Title · summary, status"), removed, brought back (its Sets belong to that line). Entities with only layout
 * Sets get no line and are counted as "moved or resized"; entities the plan adds already deleted get no line
 * either and are counted as "added and removed". The leading count is the number of things, not of ops.
 */
export function buildAuto(plan: MergePlan, source: Entities, target: Entities): { lines: AutoLine[]; summary: string } {
  if (plan.auto.length === 0) return { lines: [], summary: 'Nothing to merge automatically' }
  const world: Entities = { ...target, ...source }
  type Seen = { created?: Kind; deleted?: true; undeleted?: true; content: string[]; layout: boolean }
  const seen = new Map<string, Seen>()
  for (const op of plan.auto) {
    const id = entityOf(op)
    let s = seen.get(id)
    if (!s) seen.set(id, (s = { content: [], layout: false }))
    if ('Create' in op) s.created = op.Create.kind
    else if ('Delete' in op) s.deleted = true
    else if ('Undelete' in op) s.undeleted = true
    else if (isLayout(world[id]?.kind ?? 'Card', op.Set.field)) s.layout = true
    else if (!s.content.includes(op.Set.field)) s.content.push(op.Set.field)
  }
  const lines: AutoLine[] = []
  const added: Record<Kind, number> = { Card: 0, Frame: 0, Connection: 0 }
  let changed = 0
  let removed = 0
  let back = 0
  let laidOut = 0
  let hidden = 0
  for (const [id, s] of seen) {
    const title = titleIn(world, id)
    const kind = world[id]?.kind ?? s.created ?? 'Card'
    if (s.created) {
      if (s.deleted) {
        hidden++ // arrives deleted, only so that what refers to it stays valid
        continue
      }
      added[s.created]++
      const label = s.created === 'Connection' ? describeValue('Connection', 'label', world[id]?.fields.label ?? 'Null', world).text : EMPTY
      lines.push({ kind: `${s.created} added`, what: label === EMPTY ? title : `${title} · ${label}` })
    } else if (s.deleted) {
      removed++
      lines.push({ kind: 'Removed', what: title })
    } else if (s.undeleted) {
      back++
      lines.push({ kind: 'Brought back', what: title })
    } else if (s.content.length > 0) {
      changed++
      lines.push({ kind: 'Change', what: `${title} · ${s.content.map((n) => fieldWord(kind, n)).join(', ')}` })
    } else if (s.layout) {
      laidOut++
    }
  }
  const others = added.Card + added.Frame + added.Connection + removed + back + laidOut + hidden
  const parts = [
    added.Card > 0 ? `${count(added.Card, 'Card')} added` : '',
    added.Frame > 0 ? `${count(added.Frame, 'Frame')} added` : '',
    added.Connection > 0 ? `${count(added.Connection, 'Connection')} added` : '',
    changed > 0 ? count(changed, others > 0 ? 'other Change' : 'Change') : '',
    removed > 0 ? `${removed} removed` : '',
    back > 0 ? `${back} brought back` : '',
    laidOut > 0 ? `${laidOut} moved or resized` : '',
    hidden > 0 ? `${hidden} added and removed` : '',
  ].filter((p) => p !== '')
  const summary = parts.length === 1 ? parts[0]! : `${count(changed + others, 'Change')} · ${parts.join(', ')}`
  return { lines, summary }
}

/** Entities live on both Boards whose position or size differs and which the plan does not lay out: the target's stays. */
export function countLayoutKept(plan: MergePlan, source: Entities, target: Entities): number {
  const laidOut = new Set<string>()
  for (const op of plan.auto) {
    if ('Set' in op && isLayout(target[op.Set.entity]?.kind ?? 'Card', op.Set.field)) laidOut.add(op.Set.entity)
  }
  let n = 0
  for (const [id, s] of Object.entries(source)) {
    const t = target[id]
    if (!t || s.deleted || t.deleted || s.kind === 'Connection' || laidOut.has(id)) continue
    if (LAYOUT.some((f) => !same(s.fields[f], t.fields[f]))) n++
  }
  return n
}

/** "Before merging <source>", then "… (2)", "… (3)" until no Checkpoint in `taken` has that name. */
export function defaultCheckpointName(sourceName: string, taken: readonly string[]): string {
  const base = `Before merging ${sourceName}`
  let name = base
  for (let n = 2; taken.includes(name); n++) name = `${base} (${n})`
  return name
}

export function toDecision(choice: Choice): Decision {
  if (choice === 'source') return 'TakeSource'
  if (choice === 'target') return 'TakeTarget'
  return { Custom: choice.custom === '' ? 'Null' : { Text: choice.custom } }
}

/** The Decisions to post for the decided Conflicts, and the keys of those still without a choice. */
export function toDecisions(conflicts: readonly ConflictVM[]): { decisions: [ConflictKey, Decision][]; undecided: ConflictKey[] } {
  const decisions: [ConflictKey, Decision][] = []
  const undecided: ConflictKey[] = []
  for (const c of conflicts) {
    if (c.choice === null) undecided.push(c.key)
    else decisions.push([c.key, toDecision(c.choice)])
  }
  return { decisions, undecided }
}

/** The two Merges allowed for a Branch (v1: only with its direct parent): into it, and from it. None for `main`. */
export function mergeOptions(branch: BranchInfo, all: readonly BranchInfo[]): { intoParent?: BranchInfo; fromParent?: BranchInfo } {
  const parent = branch.parent ? all.find((b) => b.id === branch.parent!.branch) : undefined
  return parent ? { intoParent: parent, fromParent: parent } : {}
}
