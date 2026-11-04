// Where "+ Card" and "+ Frame" put the new thing: in free space as near the middle of the view as there is.
// Pure, in Board units. Each pass of the search looks only at what lies within its reach of the view, through a
// spatial index, so a Board of thousands of Cards costs little more than a small one.
import { FRAME_TITLE_SPACE, route } from './geometry'
import type { Rect } from './geometry'

/** Room kept free around the new thing, in Board units. */
export const PLACE_GAP = 24
/** How many steps out from the middle are tried, each way, in one pass. */
export const PLACE_RINGS = 40
/**
 * Passes after the first, each with steps twice as long as the one before, so the search keeps going outward until it
 * leaves whatever covers the view (a Board seen from far out, tiled with Frames). The last reaches 2^12 times as far.
 */
export const PLACE_PASSES = 12

/** A Connection's label as it is drawn: mono 10.5px, 6px of padding each side (board.css, .qb-conn-label). */
const LABEL_CHAR_W = 6.5
const LABEL_PAD_W = 16
const LABEL_H = 20
/** The spatial index's cell in the first pass, in Board units; each later pass doubles it. */
const CELL = 512

export type LabelledConnection = { from: Rect; to: Rect; text: string }

export type PlaceInput = {
  /** The new thing's box. */
  size: { w: number; h: number }
  /** Room above the box that must be free as well: a Frame's title. */
  head?: number
  /** What the person sees of the Board. */
  view: Rect
  cards: readonly Rect[]
  frames: readonly Rect[]
  /** The Connections that carry a label. */
  labels?: readonly LabelledConnection[]
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

function contains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h
}

function grow(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by }
}

/** The part of `r` within `to` (they intersect). */
function clip(r: Rect, to: Rect): Rect {
  const x = Math.max(r.x, to.x)
  const y = Math.max(r.y, to.y)
  return { x, y, w: Math.min(r.x + r.w, to.x + to.w) - x, h: Math.min(r.y + r.h, to.y + to.h) - y }
}

/** Where a Connection's label is drawn: centred on the middle of its line. */
export function labelRect(from: Rect, to: Rect, text: string): Rect {
  const { mx, my } = route(from, to)
  const w = text.length * LABEL_CHAR_W + LABEL_PAD_W
  return { x: mx - w / 2, y: my - LABEL_H / 2, w, h: LABEL_H }
}

/** Rectangles bucketed by the cells they cover, so a box only meets the few near it. */
class Grid {
  private cells = new Map<number, Rect[]>()
  private readonly cell: number

  constructor(cell: number) {
    this.cell = cell
  }

  private static key(cx: number, cy: number): number {
    return (cx + 0x8000) * 0x10000 + (cy + 0x8000)
  }

  private span(r: Rect): [number, number, number, number] {
    const c = this.cell
    return [Math.floor(r.x / c), Math.floor(r.y / c), Math.floor((r.x + r.w) / c), Math.floor((r.y + r.h) / c)]
  }

  add(r: Rect): void {
    const [x0, y0, x1, y1] = this.span(r)
    for (let cx = x0; cx <= x1; cx++)
      for (let cy = y0; cy <= y1; cy++) {
        const k = Grid.key(cx, cy)
        const cell = this.cells.get(k)
        if (cell) cell.push(r)
        else this.cells.set(k, [r])
      }
  }

  hits(box: Rect): boolean {
    const [x0, y0, x1, y1] = this.span(box)
    for (let cx = x0; cx <= x1; cx++)
      for (let cy = y0; cy <= y1; cy++) {
        const cell = this.cells.get(Grid.key(cx, cy))
        if (cell) for (const r of cell) if (intersects(r, box)) return true
      }
    return false
  }
}

/**
 * The top-left corner for a new box of `size`: the free place nearest the middle of the view, tried outward on a grid
 * of a quarter of the box. Free means clear by PLACE_GAP of every Card, Frame title and Connection label, and not
 * inside a Frame — unless the whole view is inside that Frame (the person is looking into it), where it may go
 * inside it but never across its edge. With nothing free within PLACE_RINGS steps, the search goes on outward with
 * steps twice as long each time (PLACE_PASSES), so it ends in the nearest free space beyond whatever fills the view.
 * Only with nothing free even then, the middle of the view.
 */
export function freeSpot({ size, head = 0, view, cards, frames, labels = [] }: PlaceInput): { x: number; y: number } {
  const start = { x: view.x + view.w / 2 - size.w / 2, y: view.y + view.h / 2 - size.h / 2 }
  const sx = Math.max(8, size.w / 4)
  const sy = Math.max(8, size.h / 4)
  const steps = offsets(sx, sy)
  // A Frame the view lies wholly inside may hold the new box; its title may not, and neither may any other Frame.
  const homes = view.w > 0 && view.h > 0 ? frames.filter((f) => contains(f, view)) : []
  const blocks = frames.map((f) =>
    homes.includes(f) ? { x: f.x, y: f.y - FRAME_TITLE_SPACE, w: f.w, h: FRAME_TITLE_SPACE } : { x: f.x, y: f.y - FRAME_TITLE_SPACE, w: f.w, h: f.h + FRAME_TITLE_SPACE },
  )
  const fits = (box: Rect) => homes.every((f) => contains(grow(f, -PLACE_GAP), box) || !intersects(grow(f, PLACE_GAP), box))

  for (let pass = 0, m = 1; pass <= PLACE_PASSES; pass++, m *= 2) {
    // Everything a candidate of this pass could touch; nothing further away is looked at.
    const reach = grow(
      { x: start.x - PLACE_RINGS * sx * m, y: start.y - head - PLACE_RINGS * sy * m, w: size.w + 2 * PLACE_RINGS * sx * m, h: size.h + head + 2 * PLACE_RINGS * sy * m },
      PLACE_GAP,
    )
    const grid = new Grid(CELL * m)
    const add = (r: Rect) => {
      const g = grow(r, PLACE_GAP)
      if (intersects(g, reach)) grid.add(clip(g, reach)) // a huge Frame fills only the cells within reach
    }
    for (const c of cards) add(c)
    for (const b of blocks) add(b)
    for (const l of labels) {
      // A label lies between the Cards it joins: one whose Cards are both far away cannot be in reach.
      const x = Math.min(l.from.x, l.to.x)
      const y = Math.min(l.from.y, l.to.y)
      const around = { x, y, w: Math.max(l.from.x + l.from.w, l.to.x + l.to.w) - x, h: Math.max(l.from.y + l.from.h, l.to.y + l.to.h) - y }
      if (l.text && intersects(grow(around, 64), reach)) add(labelRect(l.from, l.to, l.text))
    }
    for (const [i, j] of steps) {
      // What an earlier pass already tried is not tried again.
      if (pass > 0 && Math.abs(i) <= PLACE_RINGS / 2 && Math.abs(j) <= PLACE_RINGS / 2) continue
      const x = start.x + i * sx * m
      const y = start.y + j * sy * m
      const box = { x, y: y - head, w: size.w, h: size.h + head }
      if (!grid.hits(box) && fits(box)) return { x, y }
    }
  }
  return start
}

/** Every grid step within PLACE_RINGS of the middle, nearest first (in Board units), the same order every time. */
function offsets(sx: number, sy: number): [number, number][] {
  const out: [number, number, number][] = []
  for (let i = -PLACE_RINGS; i <= PLACE_RINGS; i++)
    for (let j = -PLACE_RINGS; j <= PLACE_RINGS; j++) out.push([i, j, (i * sx) ** 2 + (j * sy) ** 2])
  out.sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0])
  return out.map(([i, j]) => [i, j])
}
