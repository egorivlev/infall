// What importing BibTeX entries changes, as ordinary ops: pure, so it can be tested without a Board.
//
// Into a Page: one Source per entry, attached to that Card. Onto the Board: one Card per entry (title = the
// entry's title, status idea, its Source attached), in a grid inside a new Frame. Either way an entry whose
// DOI or address is already a Source on the Branch — or came earlier in the same file — reuses that Source.
import { CARD_H, CARD_W, newId, normalizeDoi, normalizeUrl, ops } from '../../../lib'
import type { Op } from '../../../lib'
import type { BibEntry } from './parse'

/** The Source on this Branch with the same DOI or address, if any (`page.findSource`). */
export type FindSource = (input: { url?: string; doi?: string }) => { id: string; cards: readonly string[] } | undefined

/** Ops in the order they must be applied, kept per entry so a batch never splits one entry. */
export type ImportPlan = {
  groups: Op[][]
  /** How many entries each group stands for (the Frame's group stands for none). */
  sizes: number[]
  /** Sources made new. */
  created: number
  /** Entries that use a Source that was already there (on the Branch, or earlier in the file). */
  reused: number
  /** The new Frame (Board import only). */
  frame?: { id: string; x: number; y: number; w: number; h: number }
}

/** One Text value may hold at most this many characters (api.md §11). */
export const MAX_TEXT = 100_000
const clip = (text: string, max = MAX_TEXT) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

function identity(e: BibEntry): { key: string; doi: string; url: string } {
  const doi = normalizeDoi(e.doi)
  const url = normalizeUrl(e.url)
  // Sources keep what was typed (the op builders trim only); the matching key is the normalised one.
  return { key: doi ? `doi:${doi}` : url ? `url:${url}` : '', doi: doi ? e.doi.trim() : '', url: url ? e.url.trim() : '' }
}

function sourceFields(e: BibEntry, doi: string, url: string) {
  const fields: { doi?: string; url?: string; title?: string; authors?: string; year?: string; note?: string } = {}
  if (doi) fields.doi = doi
  if (url) fields.url = url
  if (e.title) fields.title = clip(e.title)
  if (e.authors) fields.authors = clip(e.authors)
  if (e.year) fields.year = clip(e.year, 40)
  if (e.note) fields.note = clip(e.note)
  return fields
}

/** For each entry: the Source to attach (existing, or made by this plan) and the op that makes it, if new. */
function sourcesFor(entries: readonly BibEntry[], find: FindSource) {
  const made = new Map<string, string>()
  let created = 0
  let reused = 0
  const out = entries.map((e) => {
    const { key, doi, url } = identity(e)
    const existing = key ? find(doi ? { doi } : { url }) : undefined
    if (existing) {
      reused++
      return { id: existing.id, cards: existing.cards, create: null as Op | null }
    }
    const earlier = key ? made.get(key) : undefined
    if (earlier) {
      reused++
      return { id: earlier, cards: [] as readonly string[], create: null }
    }
    const id = newId()
    if (key) made.set(key, id)
    created++
    return { id, cards: [] as readonly string[], create: ops.createSource({ id, ...sourceFields(e, doi, url) }) }
  })
  return { out, created, reused }
}

/** Every entry as a Source on `cardId`. An entry whose Source is already on this Card adds nothing. */
export function planCardImport(entries: readonly BibEntry[], cardId: string, find: FindSource): ImportPlan {
  const { out, created, reused } = sourcesFor(entries, find)
  const onCard = new Set<string>()
  const groups = out.map(({ id, cards, create }) => {
    const group: Op[] = create ? [create] : []
    if (!cards.includes(cardId) && !onCard.has(id)) group.push(ops.attach({ card: cardId, source: id }))
    onCard.add(id)
    return group
  })
  return { groups, sizes: groups.map(() => 1), created, reused }
}

export const GRID_GAP = 24
export const FRAME_PAD = 32

/** Columns for n Cards: close to square, a little wider than tall. */
export function gridColumns(n: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(n * 1.4)))
}

/**
 * One Card per entry, laid out in a grid inside a new Frame whose top-left corner is `at`. The Frame comes first,
 * then each entry's Card, its Source when new, and the Attachment.
 */
export function planBoardImport(entries: readonly BibEntry[], at: { x: number; y: number }, frameTitle: string, find: FindSource): ImportPlan {
  const { out, created, reused } = sourcesFor(entries, find)
  const cols = gridColumns(entries.length)
  const rows = Math.max(1, Math.ceil(entries.length / cols))
  const frame = {
    id: newId(),
    x: Math.round(at.x),
    y: Math.round(at.y),
    w: FRAME_PAD * 2 + cols * CARD_W + (cols - 1) * GRID_GAP,
    h: FRAME_PAD * 2 + rows * CARD_H + (rows - 1) * GRID_GAP,
  }
  const groups: Op[][] = [[ops.createFrame({ ...frame, title: clip(frameTitle, 200) })]]
  const sizes = [0]
  entries.forEach((e, i) => {
    const card = newId()
    const x = frame.x + FRAME_PAD + (i % cols) * (CARD_W + GRID_GAP)
    const y = frame.y + FRAME_PAD + Math.floor(i / cols) * (CARD_H + GRID_GAP)
    const title = clip(e.title || e.key || '', 2000)
    const { id, create } = out[i]!
    const group: Op[] = [ops.createCard({ id: card, x, y, status: 'idea', ...(title ? { title } : {}) })]
    if (create) group.push(create)
    group.push(ops.attach({ card, source: id }))
    groups.push(group)
    sizes.push(1)
  })
  return { groups, sizes, created, reused, frame }
}

/** At most this many ops per request (the sync layer's limit) … */
export const MAX_OPS = 200
/** … and about this many bytes, well under the server's 2 MiB for ops. */
export const MAX_BYTES = 900_000

/** Packs whole groups into batches; returns the batches and how many entries each carries. */
export function packBatches(plan: Pick<ImportPlan, 'groups' | 'sizes'>, maxOps = MAX_OPS, maxBytes = MAX_BYTES): { ops: Op[]; entries: number }[] {
  const batches: { ops: Op[]; entries: number; bytes: number }[] = []
  plan.groups.forEach((group, i) => {
    if (group.length === 0) {
      // Nothing to send (already on this Card) — still counts toward progress.
      const last = batches[batches.length - 1]
      if (last) last.entries += plan.sizes[i] ?? 0
      else batches.push({ ops: [], entries: plan.sizes[i] ?? 0, bytes: 0 })
      return
    }
    const bytes = JSON.stringify(group).length
    const last = batches[batches.length - 1]
    if (last && last.ops.length + group.length <= maxOps && last.bytes + bytes <= maxBytes) {
      last.ops.push(...group)
      last.entries += plan.sizes[i] ?? 0
      last.bytes += bytes
    } else batches.push({ ops: [...group], entries: plan.sizes[i] ?? 0, bytes })
  })
  return batches.map(({ ops, entries }) => ({ ops, entries }))
}
