// Where each page of a PDF sits in the reader's scroll, and which pages are near enough to the view to be drawn.
// Pure, so it is tested without a canvas. Units: CSS pixels of the scroll content; page sizes in PDF points.
import type { PageSize } from './engine'

/** CSS pixels per PDF point at 100 % (96 dpi over 72 points per inch), as PDF viewers count it. */
export const CSS_PER_POINT = 96 / 72
/** Space between pages and around them. */
export const GAP = 12
export const PAD = 16

/** The zoom levels the buttons step through, as fractions of 100 %. */
export const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4] as const
export const MIN_ZOOM = ZOOMS[0]
export const MAX_ZOOM = ZOOMS[ZOOMS.length - 1]

export type Layout = {
  /** Top of page n at index n - 1. */
  tops: number[]
  heights: number[]
  widths: number[]
  /** Height of everything, the last gap included. */
  total: number
  /** The widest page. */
  width: number
}

/**
 * Stacks the pages top to bottom at `zoom` (1 = 100 %). A page whose size is not known yet takes `fallback`'s (the
 * first page's), so the scroll has its full length from the start.
 */
export function layoutPages(sizes: readonly (PageSize | undefined)[], count: number, fallback: PageSize, zoom: number): Layout {
  const scale = zoom * CSS_PER_POINT
  const tops: number[] = []
  const heights: number[] = []
  const widths: number[] = []
  let y = PAD
  let width = 0
  for (let i = 0; i < count; i++) {
    const s = sizes[i] ?? fallback
    const w = Math.round(s.width * scale)
    const h = Math.round(s.height * scale)
    tops.push(y)
    heights.push(h)
    widths.push(w)
    width = Math.max(width, w)
    y += h + GAP
  }
  return { tops, heights, widths, total: count === 0 ? 0 : y - GAP + PAD, width }
}

/** The index of the last page whose top is at or above `y` (0 when none). */
function pageIndexAt(layout: Layout, y: number): number {
  let lo = 0
  let hi = layout.tops.length - 1
  if (hi < 0) return 0
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (layout.tops[mid]! <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * The pages (from 1) to draw: those in the view, plus `around` pages above and below it so that scrolling a little
 * never shows a blank page. A 300-page PDF draws about five at a time.
 */
export function pagesToDraw(layout: Layout, scrollTop: number, viewHeight: number, around = 2): { first: number; last: number } {
  const n = layout.tops.length
  if (n === 0) return { first: 1, last: 0 }
  const first = pageIndexAt(layout, scrollTop)
  const last = pageIndexAt(layout, scrollTop + Math.max(0, viewHeight))
  return { first: Math.max(1, first + 1 - around), last: Math.min(n, last + 1 + around) }
}

/** The page the reader is on: the one under a line a third of the way down the view. */
export function currentPage(layout: Layout, scrollTop: number, viewHeight: number): number {
  if (layout.tops.length === 0) return 1
  return pageIndexAt(layout, scrollTop + viewHeight / 3) + 1
}

/** Where to scroll so that page `n` starts at the top of the view (with the gap above it). */
export function scrollTopFor(layout: Layout, n: number): number {
  const i = Math.min(Math.max(1, Math.round(n)), Math.max(1, layout.tops.length)) - 1
  return Math.max(0, (layout.tops[i] ?? 0) - GAP)
}

/**
 * Where the view is, as a page and how far into it (0…1): kept across a change of zoom or of the page sizes,
 * so the reader stays on the same line.
 */
export type Anchor = { page: number; fraction: number }

export function anchorAt(layout: Layout, scrollTop: number): Anchor {
  // A page's share of the scroll starts at the gap above it (where `scrollTopFor` puts the view).
  const i = pageIndexAt(layout, scrollTop + GAP)
  const top = (layout.tops[i] ?? 0) - GAP
  const h = (layout.heights[i] ?? 1) + GAP
  return { page: i + 1, fraction: Math.min(1, Math.max(0, (scrollTop - top) / h)) }
}

export function scrollTopForAnchor(layout: Layout, a: Anchor): number {
  const i = Math.min(Math.max(1, a.page), Math.max(1, layout.tops.length)) - 1
  return Math.max(0, (layout.tops[i] ?? 0) - GAP + a.fraction * ((layout.heights[i] ?? 0) + GAP))
}

/** The zoom at which the widest page fills `available` CSS pixels (the scroll's width less its padding). */
export function fitWidthZoom(widestPoints: number, available: number): number {
  if (!(widestPoints > 0) || !(available > 0)) return 1
  return clampZoom((available - 2 * PAD) / (widestPoints * CSS_PER_POINT))
}

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(z) ? z : 1))
}

/** The next zoom level up (+1) or down (-1) from `zoom`, which need not be one of the levels (fit width). */
export function stepZoom(zoom: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOMS.find((z) => z > zoom + 0.001) ?? MAX_ZOOM
  return [...ZOOMS].reverse().find((z) => z < zoom - 0.001) ?? MIN_ZOOM
}

/** "125 %" */
export function zoomLabel(zoom: number): string {
  return `${Math.round(zoom * 100)} %`
}

/**
 * Device pixels per CSS pixel for a page's canvas: the screen's ratio times the interface scale (the body's CSS
 * zoom), capped so that one page never takes more than `maxPixels` (a 400 % page on a Retina screen would).
 */
export function canvasRatio(devicePixelRatio: number, uiZoom: number, cssWidth: number, cssHeight: number, maxPixels = 16_777_216): number {
  const want = Math.max(1, devicePixelRatio || 1) * (uiZoom > 0 ? uiZoom : 1)
  const area = Math.max(1, cssWidth * cssHeight)
  return Math.min(want, Math.sqrt(maxPixels / area))
}
