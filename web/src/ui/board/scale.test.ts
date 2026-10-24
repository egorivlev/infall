// The Board at size (docs/specs/scale.md): what can be measured without a browser, on a Board shaped like the
// generated 2 000-Card Workspace. The limits are several times what this costs on the machine the numbers were taken
// on, so they fail only when something gets clearly worse (an accidental quadratic step, a lost memo), not on noise.
import { describe, expect, it } from 'vitest'
import { applyOps, toPageIndex, toSnapshotParts } from '../../lib/board-state'
import type { Entities } from '../../lib/board-state'
import type { Op } from '../../lib/types'
import { searchCards } from '../shell/searchCards'
import { overviewPaths } from './edges/overview'
import { createEdgeBuilder, createNodeBuilder } from './elements'
import { frameMembers } from './geometry'

const CARDS = 2000
const CONNECTIONS = 6000
const PAGES = 200
const BLOCKS_PER_PAGE = 12

/** A deterministic Board of the generated Workspace's shape: Frames of 25 Cards, Connections between neighbours. */
function bigBoard(): Entities {
  let seed = 1
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  const id = (prefix: string, i: number) => `${prefix}${String(i).padStart(6, '0')}-0000-4000-8000-000000000000`
  const e: Entities = {}
  const words = ['sleep', 'memory', 'soil', 'graphene', 'walks', 'protein', 'attention', 'coral', 'replication', 'pilot']
  for (let f = 0; f < CARDS / 25; f++) {
    e[id('f', f)] = { kind: 'Frame', deleted: false, fields: { title: { Text: `Frame ${f}` }, x: { Float: (f % 5) * 1600 }, y: { Float: Math.floor(f / 5) * 1100 }, w: { Float: 1400 }, h: { Float: 900 } } }
  }
  for (let i = 0; i < CARDS; i++) {
    const f = Math.floor(i / 25)
    const title = `${words[i % words.length]} and ${words[(i * 7) % words.length]} ${i}`
    e[id('c', i)] = {
      kind: 'Card',
      deleted: false,
      fields: {
        title: { Text: title },
        summary: { Text: `A sentence about ${title} that is long enough to be a summary.` },
        status: { Text: 'idea' },
        x: { Float: (f % 5) * 1600 + (i % 5) * 264 + 40 },
        y: { Float: Math.floor(f / 5) * 1100 + (Math.floor(i / 5) % 5) * 172 + 64 },
      },
    }
  }
  for (let k = 0; k < CONNECTIONS; k++) {
    const a = Math.floor(rnd() * CARDS)
    const b = Math.min(CARDS - 1, a + 1 + Math.floor(rnd() * 30))
    e[id('e', k)] = { kind: 'Connection', deleted: false, fields: { from: { Ref: id('c', a) }, to: { Ref: id('c', b) }, kind: { Text: ['related', 'directed', 'contradicts'][k % 3]! } } }
  }
  for (let p = 0; p < PAGES; p++) {
    for (let b = 0; b < BLOCKS_PER_PAGE; b++) {
      e[id('b', p * BLOCKS_PER_PAGE + b)] = { kind: 'Block', deleted: false, fields: { card: { Ref: id('c', p * 10) }, type: { Text: 'text' }, order: { Text: `U${b}` }, text: { Text: 'Some prose. '.repeat(40) } } }
    }
  }
  return e
}

/** The fastest of a few runs, in ms: the least noisy figure a test can use. */
function best(f: () => unknown, runs = 5): number {
  let min = Infinity
  for (let i = 0; i < runs; i++) {
    const t = performance.now()
    f()
    min = Math.min(min, performance.now() - t)
  }
  return min
}

describe('the Board at size', () => {
  const entities = bigBoard()
  const parts = toSnapshotParts(entities)
  const index = toPageIndex(entities)
  const card = parts.cards[100]!
  const move: Op[] = [{ Set: { entity: card.id, field: 'x', value: { Float: card.x + 8 } } }, { Set: { entity: card.id, field: 'y', value: { Float: card.y } } }]

  it('has the shape it is meant to have', () => {
    expect(parts.cards).toHaveLength(CARDS)
    expect(parts.connections).toHaveLength(CONNECTIONS)
    expect(index.blocks.size).toBe(PAGES)
  })

  it('takes in one Change without rebuilding what did not change, quickly', () => {
    const ms = best(() => {
      const r = applyOps(entities, move)
      if (!r.ok) throw new Error(r.rejection.message)
      const next = toSnapshotParts(r.entities, parts)
      toPageIndex(r.entities, index)
      return next
    })
    const r = applyOps(entities, move)
    if (!r.ok) throw new Error(r.rejection.message)
    const next = toSnapshotParts(r.entities, parts)
    // Only the moved Card is a new object; every other Card, and the Connections, keep their identity.
    expect(next.cards.filter((c, i) => c !== parts.cards[i])).toHaveLength(1)
    expect(next.connections).toBe(parts.connections)
    expect(ms).toBeLessThan(250) // about 25 ms where measured
  })

  it('rebuilds the React Flow nodes and edges of a drag step in a few milliseconds', () => {
    const counts = frameMembers(parts.frames, parts.cards)
    const nodes = createNodeBuilder()
    const edges = createEdgeBuilder()
    const byId = new Map(parts.cards.map((c) => [c.id, c]))
    const inputs = { cards: parts.cards, frames: parts.frames, counts, selected: new Set<string>(), transient: new Map(), raised: null, readOnly: false }
    const first = nodes(inputs)
    edges(parts.connections, byId, new Set())
    let x = 0
    const ms = best(() => nodes({ ...inputs, transient: new Map([[card.id, { x: (x += 1), y: 0 }]]) }))
    const after = nodes({ ...inputs, transient: new Map([[card.id, { x: 5, y: 0 }]]) })
    expect(after.filter((n, i) => n !== first[i])).toHaveLength(1)
    expect(ms).toBeLessThan(40) // under 1 ms where measured
    expect(best(() => edges(parts.connections, byId, new Set()))).toBeLessThan(60) // about 2 ms
  })

  it('draws every Connection of the far-away view as two paths, quickly', () => {
    const byId = new Map(parts.cards.map((c) => [c.id, c]))
    const ms = best(() => overviewPaths(parts.connections, byId, new Map()))
    expect(ms).toBeLessThan(150) // about 10 ms
  })

  it('searches 2 000 Cards within a keystroke', () => {
    expect(searchCards(parts.cards, 'replication').length).toBeGreaterThan(0)
    expect(best(() => searchCards(parts.cards, 'replication'))).toBeLessThan(50) // about 2.5 ms
  })
})
