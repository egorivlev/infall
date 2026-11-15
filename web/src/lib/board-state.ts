// Pure Board logic: applying operations (core.md sections 1 and 2) and building view models.
import type {
  AttachedSource,
  BlockVM,
  CardVM,
  ConnectionVM,
  Entity,
  Fields,
  FrameVM,
  Kind,
  Member,
  Op,
  PageVM,
  SourceVM,
  Value,
} from './types'
import { readRunResult } from './run-result'
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

function isRefTo(work: Entities, value: Value | undefined, kind: Kind): boolean {
  return typeof value === 'object' && 'Ref' in value && work[value.Ref]?.kind === kind
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
    if (kind === 'Connection' && !(isRefTo(work, kept.from, 'Card') && isRefTo(work, kept.to, 'Card'))) {
      return reject('invalid', entity, 'A Connection must join two existing Cards.')
    }
    if (kind === 'Block' && !isRefTo(work, kept.card, 'Card')) {
      return reject('invalid', entity, 'A block must belong to an existing Card.')
    }
    if (kind === 'Attachment' && !(isRefTo(work, kept.card, 'Card') && isRefTo(work, kept.source, 'Source'))) {
      return reject('invalid', entity, 'An Attachment must join an existing Card and an existing Source.')
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

/** M19: a count kept as a number (or, leniently, as digits in text); undefined when there is none. */
function count(fields: Fields, name: string): number | undefined {
  const v = fields[name]
  const n = typeof v === 'object' && 'Float' in v ? v.Float : typeof v === 'object' && 'Text' in v && /^\d+$/.test(v.Text) ? Number(v.Text) : NaN
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined
}

/** M19: a Source's PDF fields, only when it has a PDF (`pdf` holds its hash); flat, so Sources compare key by key. */
function sourcePdfFields(f: Fields): Pick<SourceVM, 'pdf' | 'pdfName' | 'pdfSize' | 'pdfPages'> {
  const pdf = text(f, 'pdf').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(pdf)) return {}
  const out: Pick<SourceVM, 'pdf' | 'pdfName' | 'pdfSize' | 'pdfPages'> = { pdf, pdfName: text(f, 'pdf_name'), pdfSize: count(f, 'pdf_size') ?? 0 }
  const pages = count(f, 'pdf_pages')
  if (pages !== undefined && pages > 0) out.pdfPages = pages
  return out
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

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

function sameKeys(a: Record<string, unknown>, b: Record<string, unknown>, same: (x: unknown, y: unknown) => boolean): boolean {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => k in b && same(a[k], b[k]))
}

// Equal key by key; a value that is an array (a Source's `cards`) is compared item by item.
function shallowEqual(a: object, b: object): boolean {
  return sameKeys(a as Record<string, unknown>, b as Record<string, unknown>, (x, y) => {
    return Object.is(x, y) || (Array.isArray(x) && Array.isArray(y) && sameItems(x, y))
  })
}

// As above, and a Block's `ai` (a small record made anew on every pass) is compared key by key. A Run's `run` is
// the same while it holds the same parsed result (the object itself: a result is never compared piece by piece).
function sameBlock(a: BlockVM, b: BlockVM): boolean {
  const { ai: aiA, run: runA, ...restA } = a
  const { ai: aiB, run: runB, ...restB } = b
  if (!shallowEqual(restA, restB)) return false
  if (runA !== runB && !(runA && runB && runA.result === runB.result && runA.broken === runB.broken && runA.lang === runB.lang && runA.env === runB.env))
    return false
  return aiA === undefined || aiB === undefined ? aiA === aiB : sameKeys(aiA, aiB, Object.is)
}

/**
 * What marks a Block as pinned from an AI Conversation (core.md): set for as long as `ai_pinned_by` holds a Member
 * id; `reviewedBy` once a Member marked it reviewed.
 */
export function blockAi(fields: Fields): BlockVM['ai'] {
  const pinnedBy = text(fields, 'ai_pinned_by')
  if (pinnedBy === '') return undefined
  const ai: NonNullable<BlockVM['ai']> = { model: text(fields, 'ai_model'), pinnedBy, pinnedAt: float(fields, 'ai_pinned_at', 0) }
  const reviewedBy = text(fields, 'ai_reviewed_by')
  if (reviewedBy !== '') ai.reviewedBy = reviewedBy
  return ai
}

/**
 * What a Block is, read from its `type`: unset (or not a text value) means 'text'. A type this build does not
 * know gives null: the Block stays in the entity store as it came, but is not shown and not counted.
 */
export function blockType(fields: Fields): BlockVM['type'] | null {
  const t = text(fields, 'type')
  return t === '' || t === 'text' ? 'text' : t === 'visual' || t === 'run' ? t : null
}

function isLive(entities: Entities, id: string, kind: Kind): boolean {
  const e = entities[id]
  return e !== undefined && e.kind === kind && !e.deleted
}

// Reuses previous item objects (and the previous array) when nothing changed, so identity is stable.
function reuse<T extends { id: string }>(prev: readonly T[] | undefined, next: T[], sameItem: (a: T, b: T) => boolean = shallowEqual): T[] {
  if (!prev) return next
  const old = new Map(prev.map((item) => [item.id, item]))
  const merged = next.map((item) => {
    const before = old.get(item.id)
    return before && sameItem(before, item) ? before : item
  })
  const same = merged.length === prev.length && merged.every((item, i) => item === prev[i])
  return same ? (prev as T[]) : merged
}

export function toSnapshotParts(entities: Entities, prev?: SnapshotParts): SnapshotParts {
  const cards: CardVM[] = []
  const frames: FrameVM[] = []
  const connections: ConnectionVM[] = []
  const ids = Object.keys(entities).sort()
  const liveCard = (id: string) => isLive(entities, id, 'Card')
  // Per Card: its visible Blocks, and the live Sources attached to it (each counted once).
  const blockCount = new Map<string, number>()
  const attached = new Map<string, Set<string>>()
  for (const id of ids) {
    const e = entities[id]
    if (!e || e.deleted) continue
    if (e.kind === 'Block') {
      const card = ref(e.fields, 'card')
      if (liveCard(card) && blockType(e.fields) !== null) blockCount.set(card, (blockCount.get(card) ?? 0) + 1)
    } else if (e.kind === 'Attachment') {
      const card = ref(e.fields, 'card')
      const source = ref(e.fields, 'source')
      if (!liveCard(card) || !isLive(entities, source, 'Source')) continue
      let set = attached.get(card)
      if (!set) attached.set(card, (set = new Set()))
      set.add(source)
    }
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
        blocks: blockCount.get(id) ?? 0,
        sources: attached.get(id)?.size ?? 0,
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
    } else if (e.kind === 'Connection') {
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

// ---- Pages and Sources ----

/** Everything Pages are made of, grouped per live Card. Lists keep their identity while their content is unchanged. */
export type PageIndex = {
  sources: SourceVM[] // every live Source, by title (case ignored), then id
  blocks: Map<string, BlockVM[]> // card id → its visible Blocks, by `order`, then id
  attached: Map<string, AttachedSource[]> // card id → its Sources, by year (newest first), then title
}

const NO_BLOCKS: BlockVM[] = []
const NO_ATTACHED: AttachedSource[] = []
const NO_LINKS: PageVM['connections'] = []

export const EMPTY_INDEX: PageIndex = { sources: [], blocks: new Map(), attached: new Map() }
export const EMPTY_PAGE: PageVM = { card: null, blocks: NO_BLOCKS, sources: NO_ATTACHED, connections: NO_LINKS, editor: null }

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function byTitle(a: SourceVM, b: SourceVM): number {
  return compare(a.title.toLowerCase(), b.title.toLowerCase()) || compare(a.id, b.id)
}

// Newest first; a Source without a readable year comes last.
function byYear(a: SourceVM, b: SourceVM): number {
  const ya = Number.parseInt(a.year, 10)
  const yb = Number.parseInt(b.year, 10)
  const na = Number.isNaN(ya)
  const nb = Number.isNaN(yb)
  if (na !== nb) return na ? 1 : -1
  return (na ? 0 : yb - ya) || byTitle(a, b)
}

function reuseMap<T extends { id: string }>(
  prev: Map<string, T[]> | undefined,
  next: Map<string, T[]>,
  sameItem?: (a: T, b: T) => boolean,
): Map<string, T[]> {
  if (!prev) return next
  let same = prev.size === next.size
  for (const [key, list] of next) {
    const kept = reuse(prev.get(key), list, sameItem)
    if (kept !== prev.get(key)) same = false
    next.set(key, kept)
  }
  return same ? prev : next
}

export function toPageIndex(entities: Entities, prev?: PageIndex): PageIndex {
  const ids = Object.keys(entities).sort()
  const blocks = new Map<string, BlockVM[]>()
  const sourceById = new Map<string, SourceVM>()
  const pairs: { card: string; source: string; attachment: string }[] = []
  for (const id of ids) {
    const e = entities[id]
    if (!e || e.deleted) continue
    const f = e.fields
    if (e.kind === 'Block') {
      const card = ref(f, 'card')
      const type = blockType(f)
      if (type === null || !isLive(entities, card, 'Card')) continue
      let list = blocks.get(card)
      if (!list) blocks.set(card, (list = []))
      const block: BlockVM = { id, card, type, text: text(f, 'text'), title: type === 'text' ? '' : text(f, 'title'), order: text(f, 'order') }
      // The stored result is parsed once per value (run-result.ts), so an unrelated change costs a lookup.
      if (type === 'run') {
        block.run = readRunResult(f.result)
        // M19b: what the Run names, as stored (the server checks the shape); unset leaves the shared object alone.
        const lang = text(f, 'lang')
        const env = text(f, 'env')
        if (lang !== '' || env !== '') {
          block.run = { ...block.run }
          if (lang !== '') block.run.lang = lang
          if (env !== '') block.run.env = env
        }
      }
      const ai = blockAi(f)
      if (ai) block.ai = ai
      list.push(block)
    } else if (e.kind === 'Source') {
      sourceById.set(id, {
        id,
        url: text(f, 'url'),
        doi: text(f, 'doi'),
        title: text(f, 'title'),
        authors: text(f, 'authors'),
        year: text(f, 'year'),
        note: text(f, 'note'),
        cards: [],
        ...sourcePdfFields(f),
      })
    } else if (e.kind === 'Attachment') {
      const card = ref(f, 'card')
      const source = ref(f, 'source')
      if (isLive(entities, card, 'Card') && isLive(entities, source, 'Source')) pairs.push({ card, source, attachment: id })
    }
  }
  for (const list of blocks.values()) list.sort((a, b) => compare(a.order, b.order) || compare(a.id, b.id))
  // `pairs` is in Attachment id order: of two Attachments joining the same Card and Source, the first one counts.
  const first: typeof pairs = []
  for (const p of pairs) {
    const source = sourceById.get(p.source)!
    if (source.cards.includes(p.card)) continue
    source.cards.push(p.card)
    first.push(p)
  }
  for (const s of sourceById.values()) s.cards.sort()
  const sources = reuse(prev?.sources, [...sourceById.values()].sort(byTitle))
  const kept = new Map(sources.map((s) => [s.id, s]))
  const attached = new Map<string, AttachedSource[]>()
  for (const p of first) {
    let list = attached.get(p.card)
    if (!list) attached.set(p.card, (list = []))
    list.push({ ...kept.get(p.source)!, attachment: p.attachment })
  }
  for (const list of attached.values()) list.sort(byYear)
  const next: PageIndex = {
    sources,
    blocks: reuseMap(prev?.blocks, blocks, sameBlock),
    attached: reuseMap(prev?.attached, attached),
  }
  return prev && next.sources === prev.sources && next.blocks === prev.blocks && next.attached === prev.attached ? prev : next
}

/** Who else holds a Card's Page, by Card id. */
export type Editors = Map<string, { member: Member | null; memberId: string; since: number }>

/**
 * The Page of one Card. `prev` is the Page built for the same Card before: it is returned again when nothing in
 * it changed, and its lists are kept when they did not.
 */
export function toPage(cardId: string, parts: SnapshotParts, index: PageIndex, editors: Editors, prev?: PageVM): PageVM {
  const card = parts.cards.find((c) => c.id === cardId)
  if (!card) return EMPTY_PAGE
  const cards = new Map(parts.cards.map((c) => [c.id, c]))
  const links: PageVM['connections'] = []
  for (const c of parts.connections) {
    if (c.from !== cardId && c.to !== cardId) continue
    const other = cards.get(c.from === cardId ? c.to : c.from)
    if (!other) continue
    const direction = c.kind !== 'directed' || c.from === c.to ? 'none' : c.from === cardId ? 'out' : 'in'
    links.push({ id: c.id, other, direction, kind: c.kind, label: c.label })
  }
  const next: PageVM = {
    card,
    blocks: index.blocks.get(cardId) ?? NO_BLOCKS,
    sources: index.attached.get(cardId) ?? NO_ATTACHED,
    connections: links.length === 0 ? NO_LINKS : reuse(prev?.connections, links),
    editor: editors.get(cardId) ?? null,
  }
  return prev && shallowEqual(prev, next) ? prev : next
}
