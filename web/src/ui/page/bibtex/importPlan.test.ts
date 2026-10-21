import { describe, expect, it } from 'vitest'
import { CARD_H, CARD_W } from '../../../lib'
import type { Op } from '../../../lib'
import { FRAME_PAD, GRID_GAP, MAX_BYTES, MAX_OPS, gridColumns, packBatches, planBoardImport, planCardImport } from './importPlan'
import type { FindSource } from './importPlan'
import { parseBibtex } from './parse'

const BIB = `@article{a, title = {Alpha}, author = {One, A.}, year = 2001, doi = {10.1000/ALPHA}}
@misc{b, title = {Beta}, url = {https://example.org/beta/}}
@misc{c, title = {Gamma (same DOI as Alpha)}, doi = {https://doi.org/10.1000/alpha}}
@misc{d, title = {Delta, already in Infall}, doi = {10.1000/delta}}
@book{e, title = {No identifier}}`
const entries = parseBibtex(BIB).entries

const existing: FindSource = (input) => (input.doi?.toLowerCase() === '10.1000/delta' ? { id: 'src-delta', cards: ['other-card'] } : undefined)

type Created = { Create: { entity: string; kind: string; fields: Record<string, { Text?: string; Float?: number }> } }
const creates = (ops: Op[], kind: string) => ops.filter((o): o is Op & Created => 'Create' in o && (o as unknown as Created).Create.kind === kind) as unknown as Created[]
const text = (c: Created, field: string) => c.Create.fields[field]?.Text

describe('planCardImport', () => {
  it('makes a Source per new reference and attaches each to the Card once', () => {
    const plan = planCardImport(entries, 'card-1', existing)
    const all = plan.groups.flat()
    const sources = creates(all, 'Source')
    expect(sources.map((s) => text(s, 'title'))).toEqual(['Alpha', 'Beta', 'No identifier'])
    expect(text(sources[0]!, 'doi')).toBe('10.1000/ALPHA') // kept as written; matching normalises
    expect(text(sources[0]!, 'authors')).toBe('A. One')
    expect(text(sources[1]!, 'url')).toBe('https://example.org/beta/')
    const attachments = creates(all, 'Attachment')
    expect(attachments).toHaveLength(4) // Gamma reuses Alpha's Source, which is already attached by then
    expect(attachments.map((a) => a.Create.fields.source)).toContainEqual({ Ref: 'src-delta' })
    expect(plan).toMatchObject({ created: 3, reused: 2 })
    expect(plan.groups[2]).toEqual([]) // Gamma: nothing to send
  })

  it('adds nothing for a Source already on this Card', () => {
    const plan = planCardImport(entries.slice(3, 4), 'card-1', () => ({ id: 'src-delta', cards: ['card-1'] }))
    expect(plan.groups).toEqual([[]])
    expect(plan.reused).toBe(1)
  })
})

describe('planBoardImport', () => {
  it('makes a Frame, then one Card per entry in a grid inside it, each with its Source', () => {
    const plan = planBoardImport(entries, { x: 1000.4, y: -20 }, 'library', existing)
    const all = plan.groups.flat()
    const [frame] = creates(all, 'Frame')
    expect(text(frame!, 'title')).toBe('library')
    const cols = gridColumns(5)
    expect(cols).toBe(3)
    expect(plan.frame).toEqual({
      id: frame!.Create.entity,
      x: 1000,
      y: -20,
      w: FRAME_PAD * 2 + 3 * CARD_W + 2 * GRID_GAP,
      h: FRAME_PAD * 2 + 2 * CARD_H + GRID_GAP,
    })
    const cards = creates(all, 'Card')
    expect(cards.map((c) => text(c, 'title'))).toEqual(['Alpha', 'Beta', 'Gamma (same DOI as Alpha)', 'Delta, already in Infall', 'No identifier'])
    expect(cards.map((c) => text(c, 'status'))).toEqual(Array(5).fill('idea'))
    const pos = cards.map((c) => [c.Create.fields.x?.Float, c.Create.fields.y?.Float])
    expect(pos[0]).toEqual([1000 + FRAME_PAD, -20 + FRAME_PAD])
    expect(pos[4]).toEqual([1000 + FRAME_PAD + CARD_W + GRID_GAP, -20 + FRAME_PAD + CARD_H + GRID_GAP])
    // Every Card is inside the Frame.
    for (const [x, y] of pos) {
      expect(x! + CARD_W).toBeLessThanOrEqual(plan.frame!.x + plan.frame!.w)
      expect(y! + CARD_H).toBeLessThanOrEqual(plan.frame!.y + plan.frame!.h)
    }
    expect(creates(all, 'Attachment')).toHaveLength(5)
    expect(creates(all, 'Source')).toHaveLength(3)
    expect(plan).toMatchObject({ created: 3, reused: 2 })
  })

  it('names a Card after the key when the entry has no title', () => {
    const plan = planBoardImport(parseBibtex('@misc{lonely2020}').entries, { x: 0, y: 0 }, 'x', () => undefined)
    expect(creates(plan.groups.flat(), 'Card').map((c) => text(c, 'title'))).toEqual(['lonely2020'])
  })
})

describe('packBatches', () => {
  it('keeps 500 entries under the limits, never splitting an entry, in order', () => {
    const one = (i: number) => `@article{k${i}, title = {Paper ${i}}, author = {A and B}, year = 2020, doi = {10.1000/${i}}, note = {${'n'.repeat(i % 7 === 0 ? 4000 : 10)}}}`
    const many = parseBibtex(Array.from({ length: 500 }, (_, i) => one(i)).join('\n')).entries
    const plan = planBoardImport(many, { x: 0, y: 0 }, 'big', () => undefined)
    const batches = packBatches(plan)
    expect(batches.length).toBeGreaterThan(1)
    for (const b of batches) {
      expect(b.ops.length).toBeLessThanOrEqual(MAX_OPS)
      expect(JSON.stringify(b.ops).length).toBeLessThanOrEqual(MAX_BYTES)
    }
    expect(batches.flatMap((b) => b.ops)).toEqual(plan.groups.flat())
    expect(batches.reduce((n, b) => n + b.entries, 0)).toBe(500)
    // An entry is a Card, a Source and an Attachment: a batch ends on an entry's edge.
    for (const b of batches.slice(1)) expect('Create' in b.ops[0]! && (b.ops[0] as unknown as Created).Create.kind).toBe('Card')
  })

  it('splits by size too', () => {
    const big = parseBibtex(Array.from({ length: 6 }, (_, i) => `@misc{k${i}, note = {${'x'.repeat(90_000)}}}`).join('\n')).entries
    const batches = packBatches(planCardImport(big, 'c', () => undefined), MAX_OPS, 200_000)
    expect(batches.map((b) => b.ops.length)).toEqual([4, 4, 4])
  })

  it('counts entries that send nothing', () => {
    expect(packBatches({ groups: [[], [], []], sizes: [1, 1, 1] })).toEqual([{ ops: [], entries: 3 }])
  })
})
