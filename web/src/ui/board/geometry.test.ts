import { describe, expect, it } from 'vitest'
import { arrowPath, fitBounds, frameMembers, nudge, nudgeDelta, readingOrder, route, zoomLevel } from './geometry'

const card = (id: string, x: number, y: number) => ({ id, x, y, w: 224, h: 132 })
const frame = (id: string, x: number, y: number, w: number, h: number) => ({ id, x, y, w, h })

describe('frameMembers', () => {
  it('counts a Card by its centre, not its overlap', () => {
    const f = frame('f', 0, 0, 300, 300)
    const inside = card('in', 100, 100) // centre 212,166
    const overlapping = card('over', 200, 100) // centre 312,166: overlaps but centre is outside
    const edge = card('edge', 188, 234) // centre 300,300: on the border counts
    const m = frameMembers([f], [inside, overlapping, edge])
    expect(m.get('f')).toEqual(['in', 'edge'])
  })

  it('gives every Frame an entry, even when empty', () => {
    expect(frameMembers([frame('a', 0, 0, 10, 10)], []).get('a')).toEqual([])
  })
})

describe('readingOrder', () => {
  it('reads row by row, left to right, tolerating small vertical offsets', () => {
    const cards = [card('c', 0, 200), card('b', 260, 10), card('a', 0, 0), card('d', 260, 190)]
    expect(readingOrder(cards, [])).toEqual(['a', 'b', 'c', 'd'])
  })

  it('reads Frames in order, their Cards first, then Cards outside any Frame', () => {
    const left = frame('L', 0, 0, 500, 400)
    const right = frame('R', 600, 0, 500, 400)
    const cards = [
      card('loose', 0, 600),
      card('r1', 620, 20),
      card('l2', 260, 20),
      card('l1', 20, 20),
      card('l3', 20, 200),
    ]
    expect(readingOrder(cards, [right, left])).toEqual(['l1', 'l2', 'l3', 'r1', 'loose'])
  })
})

describe('fitBounds', () => {
  it('is null for an empty Board', () => {
    expect(fitBounds([], [])).toBeNull()
  })

  it('encloses Cards and Frames, with room for Frame titles above', () => {
    const b = fitBounds([card('a', 500, 500)], [frame('f', 0, 100, 300, 200)])
    expect(b).toEqual({ x: 0, y: 60, width: 724, height: 572 })
  })
})

describe('nudge', () => {
  it('maps arrows to 8 units, 24 with Shift, and ignores other keys', () => {
    expect(nudgeDelta('ArrowLeft', false)).toEqual({ dx: -8, dy: 0 })
    expect(nudgeDelta('ArrowDown', true)).toEqual({ dx: 0, dy: 24 })
    expect(nudgeDelta('a', false)).toBeNull()
  })

  it('moves every item by the same offset', () => {
    expect(nudge([{ id: 'a', x: 1, y: 2 }, { id: 'b', x: 10, y: 20 }], { dx: 8, dy: -8 })).toEqual([
      { id: 'a', x: 9, y: -6 },
      { id: 'b', x: 18, y: 12 },
    ])
  })
})

describe('route and zoom level', () => {
  it('joins facing edge midpoints: horizontally for side-by-side Cards, vertically for stacked ones', () => {
    const h = route(card('a', 0, 0), card('b', 400, 0))
    expect(h.start).toMatchObject({ x: 224, y: 66, dx: 1, dy: 0 })
    expect(h.end).toMatchObject({ x: 400, y: 66 })
    const v = route(card('a', 0, 0), card('b', 0, 400))
    expect(v.start).toMatchObject({ x: 112, y: 132, dx: 0, dy: 1 })
    expect(v.end).toMatchObject({ x: 112, y: 400 })
    expect(arrowPath(h.end)).toContain('L400,66')
  })

  it('switches semantic zoom at 55% and 30%', () => {
    expect(zoomLevel(0.55)).toBe('full')
    expect(zoomLevel(0.54)).toBe('compact')
    expect(zoomLevel(0.3)).toBe('compact')
    expect(zoomLevel(0.29)).toBe('tile')
  })
})
