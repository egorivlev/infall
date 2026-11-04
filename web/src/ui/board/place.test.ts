import { describe, expect, it } from 'vitest'
import { FRAME_TITLE_SPACE, NEW_FRAME_H, NEW_FRAME_W } from './geometry'
import type { Rect } from './geometry'
import { PLACE_GAP, PLACE_RINGS, freeSpot, labelRect } from './place'

const CARD = { w: 224, h: 132 }
const VIEW: Rect = { x: -600, y: -400, w: 1200, h: 800 } // its middle is 0, 0
const MIDDLE = { x: -CARD.w / 2, y: -CARD.h / 2 }

const card = (x: number, y: number): Rect => ({ x, y, w: CARD.w, h: CARD.h })
const box = (at: { x: number; y: number }, size = CARD, head = 0): Rect => ({ x: at.x, y: at.y - head, w: size.w, h: size.h + head })
const meets = (a: Rect, b: Rect, gap = 0) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap
const inside = (outer: Rect, inner: Rect) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h
const title = (f: Rect): Rect => ({ x: f.x, y: f.y - FRAME_TITLE_SPACE, w: f.w, h: FRAME_TITLE_SPACE })
const distance = (at: { x: number; y: number }) => Math.hypot(at.x - MIDDLE.x, at.y - MIDDLE.y)

describe('freeSpot', () => {
  it('puts the new Card in the very middle of the view when that is free', () => {
    expect(freeSpot({ size: CARD, view: VIEW, cards: [], frames: [] })).toEqual(MIDDLE)
    // Things elsewhere on the Board change nothing.
    expect(freeSpot({ size: CARD, view: VIEW, cards: [card(2000, 2000)], frames: [{ x: -3000, y: 0, w: 500, h: 300 }] })).toEqual(MIDDLE)
  })

  it('moves off a Card in the middle, keeping clear of it and staying close', () => {
    const there = card(-100, -60)
    const at = freeSpot({ size: CARD, view: VIEW, cards: [there], frames: [] })
    expect(meets(box(at), there, PLACE_GAP)).toBe(false)
    expect(inside(VIEW, box(at))).toBe(true)
    expect(distance(at)).toBeLessThan(CARD.h + 2 * PLACE_GAP + CARD.h / 4)
  })

  it('does not land inside a Frame the view is not wholly inside, nor on its title', () => {
    const frame: Rect = { x: -300, y: -200, w: 600, h: 400 }
    const at = freeSpot({ size: CARD, view: VIEW, cards: [], frames: [frame] })
    expect(meets(box(at), { ...frame, y: frame.y - FRAME_TITLE_SPACE, h: frame.h + FRAME_TITLE_SPACE }, PLACE_GAP)).toBe(false)
  })

  it('keeps off a Frame’s title, which sits above its box', () => {
    const frame: Rect = { x: -400, y: 80, w: 800, h: 300 } // its title runs right across the middle
    const at = freeSpot({ size: CARD, view: VIEW, cards: [], frames: [frame] })
    expect(meets(box(at), title(frame), PLACE_GAP)).toBe(false)
    expect(meets(box(at), frame, PLACE_GAP)).toBe(false)
  })

  it('goes inside a Frame the whole view is inside, clear of its Cards and never across its edge', () => {
    const frame: Rect = { x: -1000, y: -800, w: 2000, h: 1600 }
    const there = card(-112, -66)
    const at = freeSpot({ size: CARD, view: VIEW, cards: [there], frames: [frame] })
    expect(inside(frame, box(at))).toBe(true)
    expect(meets(box(at), there, PLACE_GAP)).toBe(false)

    // A full Frame: out beyond its edge, never half in.
    const small: Rect = { x: -650, y: -450, w: 1300, h: 900 }
    const full = [] as Rect[]
    for (let x = small.x + 10; x < small.x + small.w; x += CARD.w + 10) for (let y = small.y + 10; y < small.y + small.h; y += CARD.h + 10) full.push(card(x, y))
    const out = freeSpot({ size: CARD, view: VIEW, cards: full, frames: [small] })
    expect(meets(box(out), small, PLACE_GAP)).toBe(false)
    for (const c of full) expect(meets(box(out), c)).toBe(false)
  })

  it('keeps off a Connection’s label', () => {
    const from = card(-700, -66)
    const to = card(476, -66) // the label is in the middle of the view
    const label = labelRect(from, to, 'contradicts the scaling in')
    expect(meets(label, box(MIDDLE))).toBe(true)
    const at = freeSpot({ size: CARD, view: VIEW, cards: [from, to], frames: [], labels: [{ from, to, text: 'contradicts the scaling in' }] })
    expect(meets(box(at), label, PLACE_GAP)).toBe(false)
    // Without a label the line alone does not move it.
    expect(freeSpot({ size: CARD, view: VIEW, cards: [from, to], frames: [], labels: [{ from, to, text: '' }] })).toEqual(MIDDLE)
  })

  it('finds the one gap on a crowded Board, the nearest free place', () => {
    const cards: Rect[] = []
    for (let i = -6; i <= 6; i++) for (let j = -6; j <= 6; j++) if (!(i === 2 && j === 1)) cards.push(card(i * 300 - 112, j * 220 - 66))
    const at = freeSpot({ size: CARD, view: VIEW, cards, frames: [] })
    for (const c of cards) expect(meets(box(at), c)).toBe(false)
    // The gap left at (2, 1): its own room plus half the spacing each side is what there is.
    expect(Math.abs(at.x - (600 - 112))).toBeLessThan(80)
    expect(Math.abs(at.y - (220 - 66))).toBeLessThan(80)
  })

  it('places a new Frame with its title clear of Cards and other Frames', () => {
    const size = { w: NEW_FRAME_W, h: NEW_FRAME_H }
    const cards = [card(-112, -66), card(300, 200)]
    const frames: Rect[] = [{ x: -900, y: -300, w: 500, h: 400 }]
    const at = freeSpot({ size, head: FRAME_TITLE_SPACE, view: VIEW, cards, frames })
    const whole = box(at, size, FRAME_TITLE_SPACE)
    for (const c of cards) expect(meets(whole, c, PLACE_GAP)).toBe(false)
    expect(meets(whole, { ...frames[0]!, y: frames[0]!.y - FRAME_TITLE_SPACE, h: frames[0]!.h + FRAME_TITLE_SPACE }, PLACE_GAP)).toBe(false)
  })

  it('goes on outward past whatever fills all around the view, however far', () => {
    const wall: Rect = { x: -100_000, y: -100_000, w: 200_000, h: 200_000 }
    const at = freeSpot({ size: CARD, view: VIEW, cards: [wall], frames: [] })
    expect(meets(box(at), wall, PLACE_GAP)).toBe(false)
  })

  it('uses the middle after all when nothing is free even far out', () => {
    const wall: Rect = { x: -1e9, y: -1e9, w: 2e9, h: 2e9 }
    expect(freeSpot({ size: CARD, view: VIEW, cards: [wall], frames: [] })).toEqual(MIDDLE)
  })

  it('seen from far out over a Board tiled with full Frames, lands outside every Frame and clear of every Card', () => {
    // As a big Workspace at 10%: Frames of 25 Cards each, 8 × 8 of them, with gaps too narrow for a Card.
    const frames: Rect[] = []
    const cards: Rect[] = []
    for (let fi = 0; fi < 8; fi++)
      for (let fj = 0; fj < 8; fj++) {
        const f = { x: fi * 1460, y: fj * 1024, w: 1360, h: 924 }
        frames.push(f)
        for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) cards.push(card(f.x + 20 + i * 264, f.y + 20 + j * 176))
      }
    const far: Rect = { x: 5840 - 4000, y: 4096 - 3500, w: 8000, h: 7000 }
    const t0 = performance.now()
    const at = freeSpot({ size: CARD, view: far, cards, frames })
    expect(performance.now() - t0).toBeLessThan(200)
    for (const f of frames) expect(meets(box(at), { ...f, y: f.y - FRAME_TITLE_SPACE, h: f.h + FRAME_TITLE_SPACE }, PLACE_GAP)).toBe(false)
    for (const c of cards) expect(meets(box(at), c, PLACE_GAP)).toBe(false)
  })

  it('stays fast on a Board of 2 000 Cards packed across the view', () => {
    // A band of 200 × 10 Cards, a little apart but closer than PLACE_GAP: the nearest free place is above or below it.
    const cards: Rect[] = []
    for (let i = 0; i < 200; i++) for (let j = 0; j < 10; j++) cards.push(card(-100 * 240 + i * 240, -5 * 150 + j * 150))
    expect(cards).toHaveLength(2000)
    const t0 = performance.now()
    const at = freeSpot({ size: CARD, view: VIEW, cards, frames: [] })
    const took = performance.now() - t0
    for (const c of cards) expect(meets(box(at), c, PLACE_GAP)).toBe(false)
    expect(took).toBeLessThan(100)
    // Straight out of the band, the shortest way: the band ends at y = 732 below and -750 above.
    expect(at.x).toBe(MIDDLE.x)
    expect(at.y).toBe(MIDDLE.y + 25 * (CARD.h / 4))
    expect(Math.abs(at.y - MIDDLE.y)).toBeLessThanOrEqual(PLACE_RINGS * (CARD.h / 4))
  })

  it('stays fast when nothing near the view is free at all', () => {
    // 10 000 overlapping Cards far around the view: every near candidate is tried, through the index, before the
    // search goes out past them.
    const cards: Rect[] = []
    for (let i = 0; i < 100; i++) for (let j = 0; j < 100; j++) cards.push(card(-6000 + i * 120, -4000 + j * 80))
    const t0 = performance.now()
    const at = freeSpot({ size: CARD, view: VIEW, cards, frames: [] })
    expect(performance.now() - t0).toBeLessThan(300)
    for (const c of cards) expect(meets(box(at), c, PLACE_GAP)).toBe(false)
  })
})
