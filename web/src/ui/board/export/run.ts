// Making an export: lay the Board out in slices, then write the SVG or draw the PNG. Saving is the caller's.
import { count, formatWhen } from '../../history/format'
import { embeddedFontCss } from './fonts'
import { TEXT } from './look'
import type { TextKind } from './look'
import { currentTheme, readPalette } from './palette'
import { breath, pngSize, renderPng } from './png'
import type { PngScale, PngSize } from './png'
import { countIn, sceneSteps, svgDocument } from './svg'
import type { Area, BoardContent, Scene } from './svg'
import { canvasMeasure, loadFaces } from './text'
import type { Measure } from './text'
import type { ExportPalette } from './palette'

export type ExportFormat = 'svg' | 'png'

export type ExportRequest = {
  format: ExportFormat
  content: BoardContent
  branch: string
  /** The moment a History preview shows (null: the start); undefined for the Board as it is now. */
  at?: number | null
  /** The part of the Board on screen, when only that is wanted. */
  visibleArea: Area | null
  /** Light colours on white, whatever the theme. */
  light: boolean
  scale: PngScale
}

export type ExportResult =
  | { format: 'svg'; svg: string; area: Area; counts: ReturnType<typeof countIn> }
  | { format: 'png'; png: Blob; area: Area; size: PngSize; counts: ReturnType<typeof countIn> }

export type Progress = (words: string) => void

const ABORT = () => new DOMException('Cancelled', 'AbortError')

/** Lays the Board out, giving the page a breath whenever a slice took more than a frame's worth of time. */
export async function sceneOf(content: BoardContent, palette: ExportPalette, measure: Measure, cancelled: () => boolean): Promise<Scene> {
  const steps = sceneSteps(content, palette, measure)
  let since = performance.now()
  for (;;) {
    const r = steps.next()
    if (r.done) return r.value
    if (performance.now() - since > 12) {
      await breath()
      if (cancelled()) throw ABORT()
      since = performance.now()
    }
  }
}

/** The document's title and description: what it shows and where it comes from. Nothing that points elsewhere. */
export function describe(req: Pick<ExportRequest, 'branch' | 'at' | 'visibleArea'>, counts: ReturnType<typeof countIn>, now = new Date()) {
  const moment = req.at === undefined ? '' : req.at === null ? ' at the start' : ` at ${formatWhen(req.at, now)}`
  const title = `Board of ${req.branch}${moment}`
  const what = [count(counts.cards, 'Card'), count(counts.frames, 'Frame'), count(counts.connections, 'Connection')].join(', ')
  const part = req.visibleArea ? 'The part of the Board that was on screen. ' : ''
  return { title, description: `${title}, exported from Infall on ${formatWhen(now.getTime(), now)}. ${part}${what}.` }
}

const KINDS = Object.keys(TEXT) as TextKind[]

/** Makes the SVG or PNG of the request. Rejects with an AbortError when `cancelled` turns true. */
export async function makeExport(req: ExportRequest, onProgress: Progress = () => {}, cancelled: () => boolean = () => false): Promise<ExportResult> {
  const cards = req.content.cards.length
  onProgress(cards > 200 ? `Laying out ${count(cards, 'Card')}…` : 'Laying out the Board…')
  await loadFaces(KINDS)
  if (cancelled()) throw ABORT()
  const palette = readPalette(req.light ? 'light' : currentTheme(), { whiteBackground: req.light })
  const scene = await sceneOf(req.content, palette, canvasMeasure(), cancelled)
  const area = req.visibleArea ?? scene.bounds
  if (!area) throw new Error('There is nothing on this Board to export yet.')
  const counts = countIn(scene, area)
  const fontCss = await embeddedFontCss(scene.faces)
  if (cancelled()) throw ABORT()
  const { title, description } = describe(req, counts)
  const doc = { palette, title, description, fontCss }
  if (req.format === 'svg') return { format: 'svg', svg: svgDocument(scene, { ...doc, area }), area, counts }
  const size = pngSize(area, req.scale)
  onProgress('Drawing the PNG…')
  const png = await renderPng(scene, area, size, {
    ...doc,
    cancelled,
    onTile: (done, total) => total > 1 && onProgress(`Drawing the PNG… ${done} of ${total}`),
  })
  return { format: 'png', png, area, size, counts }
}
