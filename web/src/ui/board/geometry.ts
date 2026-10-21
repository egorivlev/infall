// Pure geometry for the Board: Frame membership, reading order, fit bounds, nudge, Connection routing.
// Everything here is in Board units (px at 100% zoom).

export type Rect = { x: number; y: number; w: number; h: number }
export type Positioned = { id: string; x: number; y: number }
export type Bounds = { x: number; y: number; width: number; height: number }
export type ZoomLevel = 'full' | 'compact' | 'tile'

export const NUDGE = 8
export const NUDGE_BIG = 24
export const FRAME_TITLE_SPACE = 40 // the Frame title sits above the box
export const NEW_FRAME_W = 520
export const NEW_FRAME_H = 360

export function zoomLevel(zoom: number): ZoomLevel {
  return zoom < 0.3 ? 'tile' : zoom < 0.55 ? 'compact' : 'full'
}

export function centre(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
}

export function containsPoint(r: Rect, p: { x: number; y: number }): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
}

/** Card ids per Frame. A Card belongs to every Frame that contains its centre. */
export function frameMembers<C extends Rect & { id: string }, F extends Rect & { id: string }>(
  frames: readonly F[],
  cards: readonly C[],
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const f of frames) out.set(f.id, [])
  for (const c of cards) {
    const p = centre(c)
    for (const f of frames) if (containsPoint(f, p)) out.get(f.id)!.push(c.id)
  }
  return out
}

/** Rows top to bottom, each row left to right. Items whose top is within `tolerance` of the row's first item share a row. */
function rows<T extends { x: number; y: number }>(items: readonly T[], tolerance: number): T[] {
  const byY = [...items].sort((a, b) => a.y - b.y || a.x - b.x)
  const out: T[] = []
  let row: T[] = []
  let rowY = 0
  for (const it of byY) {
    if (row.length > 0 && it.y - rowY >= tolerance) {
      out.push(...row.sort((a, b) => a.x - b.x))
      row = []
    }
    if (row.length === 0) rowY = it.y
    row.push(it)
  }
  out.push(...row.sort((a, b) => a.x - b.x))
  return out
}

/**
 * Reading order of Cards: Frames in reading order, the Cards of each Frame row by row,
 * then the Cards outside any Frame, row by row.
 */
export function readingOrder<C extends Rect & { id: string }, F extends Rect & { id: string }>(
  cards: readonly C[],
  frames: readonly F[],
): string[] {
  const orderedFrames = rows(frames, 60)
  const groups = new Map<string, C[]>()
  const loose: C[] = []
  for (const c of cards) {
    const p = centre(c)
    const home = orderedFrames.find((f) => containsPoint(f, p))
    if (home) {
      const g = groups.get(home.id)
      if (g) g.push(c)
      else groups.set(home.id, [c])
    } else loose.push(c)
  }
  const out: string[] = []
  for (const f of orderedFrames) {
    const g = groups.get(f.id)
    if (g) for (const c of rows(g, c0h(g))) out.push(c.id)
  }
  for (const c of rows(loose, c0h(loose))) out.push(c.id)
  return out
}

function c0h(items: readonly Rect[]): number {
  return (items[0]?.h ?? 132) / 2
}

/** The rectangle that holds every Card and Frame (Frame titles included), or null for an empty Board. */
export function fitBounds(cards: readonly Rect[], frames: readonly Rect[]): Bounds | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const f of frames) {
    x0 = Math.min(x0, f.x)
    y0 = Math.min(y0, f.y - FRAME_TITLE_SPACE)
    x1 = Math.max(x1, f.x + f.w)
    y1 = Math.max(y1, f.y + f.h)
  }
  for (const c of cards) {
    x0 = Math.min(x0, c.x)
    y0 = Math.min(y0, c.y)
    x1 = Math.max(x1, c.x + c.w)
    y1 = Math.max(y1, c.y + c.h)
  }
  if (!Number.isFinite(x0)) return null
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/** Arrow key → offset, 8 units (24 with Shift). Null for any other key. */
export function nudgeDelta(key: string, shift: boolean): { dx: number; dy: number } | null {
  const s = shift ? NUDGE_BIG : NUDGE
  switch (key) {
    case 'ArrowLeft':
      return { dx: -s, dy: 0 }
    case 'ArrowRight':
      return { dx: s, dy: 0 }
    case 'ArrowUp':
      return { dx: 0, dy: -s }
    case 'ArrowDown':
      return { dx: 0, dy: s }
    default:
      return null
  }
}

export function nudge(items: readonly Positioned[], d: { dx: number; dy: number }): Positioned[] {
  return items.map((it) => ({ id: it.id, x: it.x + d.dx, y: it.y + d.dy }))
}

export type RouteEnd = { x: number; y: number; dx: number; dy: number } // dx/dy: unit direction of travel
export type Route = { d: string; mx: number; my: number; start: RouteEnd; end: RouteEnd }

/** Cubic curve between the facing edge midpoints of two Cards (horizontal unless the Cards are mostly stacked). */
export function route(a: Rect, b: Rect): Route {
  const ax = a.x + a.w / 2
  const ay = a.y + a.h / 2
  const bx = b.x + b.w / 2
  const by = b.y + b.h / 2
  const dx = bx - ax
  const dy = by - ay
  let p1: [number, number]
  let p2: [number, number]
  let c1: [number, number]
  let c2: [number, number]
  let dir: [number, number]
  if (Math.abs(dx) * 0.62 > Math.abs(dy)) {
    const s = Math.sign(dx)
    p1 = [ax + (s * a.w) / 2, ay]
    p2 = [bx - (s * b.w) / 2, by]
    const k = Math.max(30, Math.abs(p2[0] - p1[0]) / 2)
    c1 = [p1[0] + s * k, p1[1]]
    c2 = [p2[0] - s * k, p2[1]]
    dir = [s, 0]
  } else {
    const s = Math.sign(dy) || 1
    p1 = [ax, ay + (s * a.h) / 2]
    p2 = [bx, by - (s * b.h) / 2]
    const k = Math.max(24, Math.abs(p2[1] - p1[1]) / 2)
    c1 = [p1[0], p1[1] + s * k]
    c2 = [p2[0], p2[1] - s * k]
    dir = [0, s]
  }
  return {
    d: `M${p1[0]},${p1[1]} C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`,
    mx: (p1[0] + 3 * c1[0] + 3 * c2[0] + p2[0]) / 8,
    my: (p1[1] + 3 * c1[1] + 3 * c2[1] + p2[1]) / 8,
    start: { x: p1[0], y: p1[1], dx: dir[0], dy: dir[1] },
    end: { x: p2[0], y: p2[1], dx: dir[0], dy: dir[1] },
  }
}

/** Open chevron whose tip sits on the end point. */
export function arrowPath(e: RouteEnd, len = 8, half = 4.5): string {
  const bx = e.x - e.dx * len
  const by = e.y - e.dy * len
  const px = -e.dy * half
  const py = e.dx * half
  return `M${bx + px},${by + py} L${e.x},${e.y} L${bx - px},${by - py}`
}

/** Short bar across the line, `inset` units back from the end point (towards the curve). */
export function barPath(e: RouteEnd, towardsCurve: 1 | -1, inset = 4, half = 5): string {
  const cx = e.x + e.dx * inset * towardsCurve
  const cy = e.y + e.dy * inset * towardsCurve
  const px = -e.dy * half
  const py = e.dx * half
  return `M${cx + px},${cy + py} L${cx - px},${cy - py}`
}

// ---- M5: the Suggestions panel and the Connection it previews ----

export const SUGGESTIONS_W = 420 // the Suggestions panel, docked left of the Board
const PAGE_MIN_W = 480 // the Page panel never gets narrower than this
const BOARD_MIN_W = 320 // what must stay of the Board between the two side panels

/**
 * Under this width (interface pixels) the Board area is "cramped": a side panel docked beside the Board would leave it
 * a useless strip, so the Suggestions panel or the Page panel takes the whole area and the Board waits underneath.
 * A narrow window does it, and so does a large interface scale (a 900-pixel window at 150 % has 600).
 */
export const CRAMPED_W = 640

/** Whether a Board area this wide is cramped (0: not laid out yet, so not). */
export function isCramped(areaWidth: number): boolean {
  return areaWidth > 0 && areaWidth < CRAMPED_W
}

/** Whether the Suggestions panel and the Page panel fit side by side in a Board area this wide. */
export function sidePanelsFit(areaWidth: number): boolean {
  return areaWidth - SUGGESTIONS_W - PAGE_MIN_W >= BOARD_MIN_W
}

/** The rectangle around two Cards. */
export function boundsOf(a: Rect, b: Rect): Bounds {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, width: Math.max(a.x + a.w, b.x + b.w) - x, height: Math.max(a.y + a.h, b.y + b.h) - y }
}

export type View = { x: number; y: number; zoom: number }

/**
 * The viewport that shows all of `b` in a `width` × `height` view (screen px), moving as little as possible:
 * null when it is already fully in view; a pan that leaves `pad` px around it; a smaller zoom, centred,
 * only when it does not fit at the current one.
 */
export function viewToShow(b: Bounds, view: View, width: number, height: number, pad = 48, minZoom = 0.1): View | null {
  if (width <= 0 || height <= 0) return null
  const { zoom } = view
  const left = b.x * zoom + view.x
  const top = b.y * zoom + view.y
  const right = left + b.width * zoom
  const bottom = top + b.height * zoom
  if (left >= 0 && top >= 0 && right <= width && bottom <= height) return null
  const room = Math.min(pad, width / 4, height / 4)
  if (b.width * zoom + 2 * room > width || b.height * zoom + 2 * room > height) {
    const z = Math.max(minZoom, Math.min(zoom, (width - 2 * room) / b.width, (height - 2 * room) / b.height))
    return { x: width / 2 - (b.x + b.width / 2) * z, y: height / 2 - (b.y + b.height / 2) * z, zoom: z }
  }
  // Each axis moves only if something is cut off along it.
  const dx = left < 0 ? room - left : right > width ? width - room - right : 0
  const dy = top < 0 ? room - top : bottom > height ? height - room - bottom : 0
  return { x: view.x + dx, y: view.y + dy, zoom }
}
