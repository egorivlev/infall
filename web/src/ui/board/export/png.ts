// The Board as a PNG: the exported SVG, drawn into a canvas at 1×, 2× or 4×. A large Board is drawn in tiles (one
// small SVG document per tile, with only what reaches into it), with a breath for the page between tiles, so no
// single step holds the page for long; and the size is capped so that a Board of thousands of Cards gives an image
// a computer can still open, rather than one that fails to be made or to be read.
import { svgDocument } from './svg'
import type { Area, DocumentOptions, Scene } from './svg'

export const PNG_SCALES = [1, 2, 4] as const
export type PngScale = (typeof PNG_SCALES)[number]
export const DEFAULT_PNG_SCALE: PngScale = 2

/** No side longer than this: browsers refuse larger canvases (Chrome and WebKit at 16 384 or 32 767). */
export const MAX_SIDE = 16_384
/** At most this many pixels (about 33.5 million, 134 MB while it is drawn): larger images are slow to make and to open. */
export const MAX_PIXELS = 32 * 1024 * 1024

export type PngSize = {
  width: number
  height: number
  /** Pixels per Board unit actually used. */
  scale: number
  /** The size asked for, when the cap made it smaller. */
  wanted: { width: number; height: number } | null
}

/** The size of a PNG of `area` at `scale`, kept under MAX_SIDE and MAX_PIXELS by drawing it at a smaller scale. */
export function pngSize(area: Pick<Area, 'w' | 'h'>, scale: number): PngSize {
  const w = Math.max(1, area.w)
  const h = Math.max(1, area.h)
  const wantW = Math.ceil(w * scale)
  const wantH = Math.ceil(h * scale)
  const fit = Math.min(scale, MAX_SIDE / Math.max(w, h), Math.sqrt(MAX_PIXELS / (w * h)))
  if (fit >= scale) return { width: wantW, height: wantH, scale, wanted: null }
  const width = Math.max(1, Math.min(MAX_SIDE, Math.floor(w * fit)))
  const height = Math.max(1, Math.min(MAX_SIDE, Math.floor(h * fit)))
  return { width, height, scale: Math.min(width / w, height / h), wanted: { width: wantW, height: wantH } }
}

/** Square tiles of this many pixels: each is one SVG drawn into its part of the canvas. */
export const TILE = 2048

export type Tile = { x: number; y: number; width: number; height: number; area: Area }

/** The tiles of a `size` picture of `area`, row by row. */
export function tiles(area: Area, size: PngSize, tile = TILE): Tile[] {
  const out: Tile[] = []
  const kx = area.w / size.width
  const ky = area.h / size.height
  for (let y = 0; y < size.height; y += tile) {
    for (let x = 0; x < size.width; x += tile) {
      const width = Math.min(tile, size.width - x)
      const height = Math.min(tile, size.height - y)
      out.push({ x, y, width, height, area: { x: area.x + x * kx, y: area.y + y * ky, w: width * kx, h: height * ky } })
    }
  }
  return out
}

/**
 * The SVG as an image. A data: URL, not a blob: one: the server's Content-Security-Policy allows images from the app
 * itself and from data: only (crates/server: `img-src 'self' data:`), so a blob: image would never load.
 */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  const img = new Image()
  return new Promise((resolve, reject) => {
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('The picture could not be drawn.'))
    img.src = svgDataUrl(svg)
  })
}

/** Lets the page paint and take input. */
export const breath = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

export type RenderOptions = Omit<DocumentOptions, 'area' | 'width' | 'height'> & {
  onTile?: (done: number, total: number) => void
  /** Checked between tiles; true stops the work (the promise rejects with an AbortError). */
  cancelled?: () => boolean
}

/** Draws `area` of the scene at `size` and encodes it as PNG. */
export async function renderPng(scene: Scene, area: Area, size: PngSize, opts: RenderOptions): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser cannot draw a picture this large.')
  try {
    const list = tiles(area, size)
    let n = 0
    for (const t of list) {
      if (opts.cancelled?.()) throw new DOMException('Cancelled', 'AbortError')
      const svg = svgDocument(scene, { ...opts, area: t.area, width: t.width, height: t.height, exact: true })
      const img = await loadSvgImage(svg)
      ctx.drawImage(img, t.x, t.y, t.width, t.height)
      opts.onTile?.(++n, list.length)
      await breath()
    }
    if (opts.cancelled?.()) throw new DOMException('Cancelled', 'AbortError')
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('This browser could not make the PNG.')
    return blob
  } finally {
    // Gives the memory back at once rather than when the canvas is collected.
    canvas.width = 0
    canvas.height = 0
  }
}
