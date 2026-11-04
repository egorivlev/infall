// The Board as a standalone SVG, built from the Board's data (never from the screen: the live Board draws only what
// is in view on a large Board, and far away draws Connections as one picture — docs/specs/scale.md).
//
// Two steps, so that a large Board can be built in slices and a PNG drawn in tiles: `sceneSteps` lays every Frame,
// Connection and Card out once, as SVG markup with its bounding box; `svgDocument` writes the document for an area,
// with the pieces that reach into it.
import type { CardVM, ConnectionVM, FrameVM, Status } from '../../../lib'
import { arrowPath, barPath, fitBounds, frameMembers, route } from '../geometry'
import { STATUS_LABEL } from '../status'
import { CARD, CONNECTION, FAMILY, FRAME, GLYPH, GLYPH_STROKE, MARGIN, TEXT, baseline } from './look'
import type { Family, TextKind, TextStyle } from './look'
import type { ExportPalette } from './palette'
import { wrapLines, xml } from './text'
import type { Measure } from './text'

export type BoardContent = {
  cards: readonly CardVM[]
  frames: readonly FrameVM[]
  connections: readonly ConnectionVM[]
}

/** A rectangle in Board units. */
export type Area = { x: number; y: number; w: number; h: number }

/** One drawn thing: its markup and the box it covers. */
type Piece = { x0: number; y0: number; x1: number; y1: number; svg: string }

/** The faces an export's text is set in, with the characters of each (for embedding only what is used). */
export type FaceUse = Map<string, Set<number>>

export type Scene = {
  frames: Piece[]
  connections: Piece[]
  labels: Piece[]
  cards: Piece[]
  /** Everything, with a margin: the area of a whole-Board export. Null for an empty Board. */
  bounds: Area | null
  /** Whether a Dead end Card is drawn (its hatch pattern is then defined). */
  dead: boolean
  faces: FaceUse
}

/** `sans-600`, `serif-400-italic`: the key of a face in `FaceUse`. */
export function faceKey(family: Family, weight: number, italic: boolean): string {
  return `${family}-${weight}${italic ? '-italic' : ''}`
}

/** A number for the file: at most two decimals, no "-0". */
function n(v: number): string {
  const r = Math.round(v * 100) / 100
  return Object.is(r, -0) ? '0' : String(r)
}

/** An id that is a valid XML name whatever the entity id is. */
export function svgId(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/[^A-Za-z0-9_.-]/g, '_')}`
}

function font(kind: TextKind, base: Family = 'sans'): string {
  const s: TextStyle = TEXT[kind]
  const parts = [`font-size="${n(s.size)}"`]
  if (s.family !== base) parts.push(`font-family="${FAMILY[s.family]}"`)
  if (s.weight !== 400) parts.push(`font-weight="${s.weight}"`)
  if (s.italic) parts.push('font-style="italic"')
  if (s.letterSpacing) parts.push(`letter-spacing="${n(s.letterSpacing)}"`)
  return parts.join(' ')
}

class Collector {
  faces: FaceUse = new Map()
  use(kind: TextKind, text: string) {
    const s = TEXT[kind]
    const key = faceKey(s.family, s.weight, s.italic)
    let set = this.faces.get(key)
    if (!set) this.faces.set(key, (set = new Set()))
    for (const ch of text) set.add(ch.codePointAt(0)!)
  }
}

function glyph(status: Status, x: number, y: number, colour: string): string {
  const shapes = GLYPH[status].map((s) => {
    const fill = s.fill ? `fill="${colour}"` : 'fill="none"'
    const stroke = s.stroked === false ? ' stroke="none"' : s.strokeWidth ? ` stroke-width="${s.strokeWidth}"` : ''
    return s.tag === 'path' ? `<path d="${s.d}" ${fill}${stroke}/>` : `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" ${fill}${stroke}/>`
  })
  return `<g class="status-glyph" transform="translate(${n(x)},${n(y)})" stroke="${colour}" stroke-width="${GLYPH_STROKE}">${shapes.join('')}</g>`
}

/** `<text>` with one absolutely placed `<tspan>` per line. */
function lines(cls: string, kind: TextKind, list: readonly string[], x: number, top: number, fill: string): string {
  if (list.length === 0) return ''
  const s = TEXT[kind]
  const b = baseline(s)
  const spans = list.map((l, i) => `<tspan x="${n(x)}" y="${n(top + b + i * s.line)}">${xml(l)}</tspan>`).join('')
  return `<text class="${cls}" ${font(kind)} fill="${fill}">${spans}</text>`
}

function frameSvg(f: FrameVM, count: number, p: ExportPalette, measure: Measure, faces: Collector): Piece {
  const b = FRAME.border
  const title = f.title.replace(/\s+/g, ' ').trim()
  const shown = title || 'Untitled'
  const countText = `${count} ${count === 1 ? 'Card' : 'Cards'}`
  faces.use('frameTitle', shown)
  faces.use('frameCount', countText)
  // .qb-frame__label: from the left of the padding box + 20, its bottom 10 above the Frame; title and count share a baseline.
  const lx = f.x + b + FRAME.labelLeft
  const labelH = TEXT.frameTitle.line
  const top = f.y + b - FRAME.labelGap - labelH
  const base = top + baseline(TEXT.frameTitle)
  const titleW = measure(shown, 'frameTitle')
  const cx = lx + titleW + FRAME.countGap
  const countW = measure(countText, 'frameCount')
  const svg =
    `<g id="${svgId('frame', f.id)}" class="frame">` +
    `<rect x="${n(f.x + b / 2)}" y="${n(f.y + b / 2)}" width="${n(Math.max(0, f.w - b))}" height="${n(Math.max(0, f.h - b))}" rx="${n(FRAME.radius - b / 2)}" fill="${p.frameFill}" stroke="${p.frameLine}" stroke-width="${b}"/>` +
    `<text class="frame-title" x="${n(lx)}" y="${n(base)}" ${font('frameTitle')} fill="${title ? p.frameTitle : p.frameTitleEmpty}">${xml(shown)}</text>` +
    `<text class="frame-count" x="${n(cx)}" y="${n(base)}" ${font('frameCount')} fill="${p.frameCount}">${xml(countText)}</text>` +
    `</g>`
  return { x0: f.x, y0: top, x1: Math.max(f.x + f.w, cx + countW), y1: f.y + f.h, svg }
}

function cardSvg(c: CardVM, p: ExportPalette, measure: Measure, faces: Collector): Piece {
  const b = CARD.border
  const dead = c.status === 'dead_end'
  const colour = p.status[c.status]
  const left = c.x + b + CARD.padX
  const inner = Math.max(0, c.w - 2 * (b + CARD.padX))
  const bottom = c.y + c.h - b - CARD.padBottom
  let y = c.y + b + CARD.padTop
  const out: string[] = []
  out.push(`<g id="${svgId('card', c.id)}" class="card status-${c.status}${dead ? ' dead' : ''}">`)
  const rect = `x="${n(c.x + b / 2)}" y="${n(c.y + b / 2)}" width="${n(Math.max(0, c.w - b))}" height="${n(Math.max(0, c.h - b))}" rx="${n(CARD.radius - b / 2)}"`
  out.push(`<rect class="card-box" ${rect} fill="${dead ? p.deadFill : p.card}" stroke="${dead ? p.deadLine : p.cardLine}" stroke-width="${b}"/>`)
  if (dead) out.push(`<rect class="card-hatch" ${rect} fill="url(#hatch-dead)" stroke="none"/>`)

  // The top row: glyph and status word, centred in a 14-unit row.
  const word = STATUS_LABEL[c.status].toUpperCase()
  faces.use('status', word)
  out.push(glyph(c.status, left, y + (CARD.topRow - CARD.glyph) / 2, colour))
  const statusTop = y + (CARD.topRow - TEXT.status.line) / 2
  out.push(
    `<text class="card-status" x="${n(left + CARD.glyph + CARD.glyphGap)}" y="${n(statusTop + baseline(TEXT.status))}" ${font('status')} fill="${colour}">${xml(word)}</text>`,
  )
  y += CARD.topRow + CARD.gap

  // Title, at most two lines; "Untitled" in the quiet colour when there is none.
  const titleKind: TextKind = c.title.trim() ? 'title' : 'titleEmpty'
  const title = wrapLines(c.title.trim() || 'Untitled', inner, CARD.titleLines, titleKind, measure)
  for (const l of title) faces.use(titleKind, l)
  out.push(lines('card-title', titleKind, title, left, y, c.title.trim() ? p.title : p.titleEmpty))
  y += Math.max(1, title.length) * TEXT.title.line + CARD.gap

  // Summary, at most two lines (serif italic on a Dead end Card).
  const sumKind: TextKind = dead ? 'deadSummary' : 'summary'
  const room = Math.max(0, Math.floor((bottom - y + 0.5) / TEXT[sumKind].line))
  const summary = wrapLines(c.summary, inner, Math.min(CARD.summaryLines, room), sumKind, measure)
  for (const l of summary) faces.use(sumKind, l)
  out.push(lines('card-summary', sumKind, summary, left, y, p.summary))

  // The footer: "¶ 4" and "3 Sources", at the bottom.
  const foot: string[] = []
  if (c.blocks > 0) foot.push(`¶ ${c.blocks}`)
  if (c.sources > 0) foot.push(`${c.sources} ${c.sources === 1 ? 'Source' : 'Sources'}`)
  if (foot.length > 0) {
    const top = bottom - TEXT.foot.line
    let x = left
    const spans: string[] = []
    for (const f of foot) {
      faces.use('foot', f)
      spans.push(`<tspan x="${n(x)}" y="${n(top + baseline(TEXT.foot))}">${xml(f)}</tspan>`)
      x += measure(f, 'foot') + CARD.footGap
    }
    out.push(`<text class="card-foot" ${font('foot')} fill="${p.foot}">${spans.join('')}</text>`)
  }
  out.push('</g>')
  return { x0: c.x, y0: c.y, x1: c.x + c.w, y1: c.y + c.h, svg: out.join('') }
}

type Placed = { conn: Piece; label: Piece | null }

function connectionSvg(conn: ConnectionVM, a: CardVM, b: CardVM, p: ExportPalette, measure: Measure, faces: Collector): Placed {
  const r = route(a, b)
  const caps: string[] = []
  if (conn.kind === 'directed') caps.push(arrowPath(r.end))
  else if (conn.kind === 'contradicts') caps.push(barPath(r.start, 1), barPath(r.end, -1))
  const capSvg = caps.length ? `<path class="connection-end" d="${caps.join(' ')}" stroke-width="${CONNECTION.capWidth}"/>` : ''
  const svg =
    `<g id="${svgId('connection', conn.id)}" class="connection kind-${conn.kind}" fill="none" stroke="${p.connection}" stroke-opacity="${p.connectionOpacity}" stroke-width="${CONNECTION.width}" stroke-linecap="round" stroke-linejoin="round">` +
    `<path class="connection-line" d="${r.d}"/>${capSvg}</g>`
  // A cubic curve stays inside the box of its end and control points; the ends reach 8 units further at most.
  const pts = r.d.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g)?.map(Number) ?? []
  const xs = pts.filter((_, i) => i % 2 === 0)
  const ys = pts.filter((_, i) => i % 2 === 1)
  const reach = 10
  const piece: Piece = { x0: Math.min(...xs) - reach, y0: Math.min(...ys) - reach, x1: Math.max(...xs) + reach, y1: Math.max(...ys) + reach, svg }

  const label = conn.label.replace(/\s+/g, ' ').trim()
  if (!label) return { conn: piece, label: null }
  faces.use('label', label)
  const w = measure(label, 'label') + 2 * (CONNECTION.labelPadX + 1)
  const h = TEXT.label.line + 2 * (CONNECTION.labelPadY + 1)
  const x = r.mx - w / 2
  const y = r.my - h / 2
  const labelSvg =
    `<g class="connection-label" data-connection="${svgId('connection', conn.id)}">` +
    `<rect x="${n(x + 0.5)}" y="${n(y + 0.5)}" width="${n(w - 1)}" height="${n(h - 1)}" rx="${n(CONNECTION.labelRadius - 0.5)}" fill="${p.labelFill}" stroke="${p.labelLine}" stroke-width="1"/>` +
    `<text x="${n(r.mx)}" y="${n(y + 1 + CONNECTION.labelPadY + baseline(TEXT.label))}" text-anchor="middle" ${font('label')} fill="${p.labelInk}">${xml(label)}</text>` +
    `</g>`
  return { conn: piece, label: { x0: x, y0: y, x1: x + w, y1: y + h, svg: labelSvg } }
}

/**
 * Lays the Board out, yielding after every `slice` Cards (and Connections) so that a caller can give the page a
 * breath between slices; the result is the Scene. `buildScene` runs it in one go.
 */
export function* sceneSteps(content: BoardContent, palette: ExportPalette, measure: Measure, slice = 250): Generator<void, Scene> {
  const faces = new Collector()
  const counts = frameMembers(content.frames, content.cards)
  const frames = content.frames.map((f) => frameSvg(f, counts.get(f.id)?.length ?? 0, palette, measure, faces))
  yield
  const byId = new Map(content.cards.map((c) => [c.id, c]))
  const connections: Piece[] = []
  const labels: Piece[] = []
  let k = 0
  for (const c of content.connections) {
    const a = byId.get(c.from)
    const b = byId.get(c.to)
    // A Connection whose Card was removed is not drawn, as on the Board.
    if (!a || !b || a === b) continue
    const placed = connectionSvg(c, a, b, palette, measure, faces)
    connections.push(placed.conn)
    if (placed.label) labels.push(placed.label)
    if (++k % (slice * 4) === 0) yield
  }
  const cards: Piece[] = []
  let dead = false
  for (const c of content.cards) {
    cards.push(cardSvg(c, palette, measure, faces))
    if (c.status === 'dead_end') dead = true
    if (cards.length % slice === 0) yield
  }
  return { frames, connections, labels, cards, bounds: sceneBounds(content, frames, labels), dead, faces: faces.faces }
}

export function buildScene(content: BoardContent, palette: ExportPalette, measure: Measure): Scene {
  const steps = sceneSteps(content, palette, measure)
  for (;;) {
    const r = steps.next()
    if (r.done) return r.value
  }
}

function sceneBounds(content: BoardContent, frames: readonly Piece[], labels: readonly Piece[]): Area | null {
  const fit = fitBounds(content.cards, content.frames)
  if (!fit) return null
  let x0 = fit.x
  let y0 = fit.y
  let x1 = fit.x + fit.width
  let y1 = fit.y + fit.height
  for (const p of [...frames, ...labels]) {
    x0 = Math.min(x0, p.x0)
    y0 = Math.min(y0, p.y0)
    x1 = Math.max(x1, p.x1)
    y1 = Math.max(y1, p.y1)
  }
  return { x: Math.floor(x0 - MARGIN), y: Math.floor(y0 - MARGIN), w: Math.ceil(x1 - x0 + 2 * MARGIN), h: Math.ceil(y1 - y0 + 2 * MARGIN) }
}

function touches(p: Piece, a: Area): boolean {
  return p.x1 >= a.x && p.x0 <= a.x + a.w && p.y1 >= a.y && p.y0 <= a.y + a.h
}

/** The pieces of each layer that reach into `area`, and how many of each. */
export function piecesIn(scene: Scene, area: Area) {
  const pick = (list: readonly Piece[]) => list.filter((p) => touches(p, area))
  return { frames: pick(scene.frames), connections: pick(scene.connections), labels: pick(scene.labels), cards: pick(scene.cards) }
}

export type DocumentOptions = {
  palette: ExportPalette
  /** What the picture shows, in Board units. */
  area: Area
  /** The size the document asks to be drawn at; the area's own size (1 unit = 1 px) when left out. */
  width?: number
  height?: number
  /** `<title>` of the document. */
  title: string
  /** `<desc>`: where it comes from. */
  description?: string
  /** @font-face rules to embed (data: URLs only). */
  fontCss?: string
  /** Fill `width` × `height` exactly even if its proportions differ from the area's by rounding (PNG tiles). */
  exact?: boolean
}

/** A standalone SVG document of the scene's pieces in `area`. */
export function svgDocument(scene: Scene, opts: DocumentOptions): string {
  const { area, palette: p } = opts
  const width = opts.width ?? area.w
  const height = opts.height ?? area.h
  const pieces = piecesIn(scene, area)
  const defs: string[] = []
  if (opts.fontCss) defs.push(`<style type="text/css"><![CDATA[\n${opts.fontCss.replace(/]]>/g, '')}\n]]></style>`)
  if (scene.dead && pieces.cards.length > 0) {
    defs.push(
      `<pattern id="hatch-dead" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
        `<rect x="7" y="0" width="1" height="8" fill="${p.deadHatch}" fill-opacity="${p.deadHatchOpacity}"/></pattern>`,
    )
  }
  const layer = (id: string, list: readonly Piece[]) => (list.length ? `<g id="${id}">\n${list.map((x) => x.svg).join('\n')}\n</g>\n` : '')
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${n(width)}" height="${n(height)}" viewBox="${n(area.x)} ${n(area.y)} ${n(area.w)} ${n(area.h)}"${opts.exact ? ' preserveAspectRatio="none"' : ''} font-family="${FAMILY.sans}" role="img" aria-label="${xml(opts.title)}">\n` +
    `<title>${xml(opts.title)}</title>\n` +
    (opts.description ? `<desc>${xml(opts.description)}</desc>\n` : '') +
    (defs.length ? `<defs>\n${defs.join('\n')}\n</defs>\n` : '') +
    `<rect id="background" x="${n(area.x)}" y="${n(area.y)}" width="${n(area.w)}" height="${n(area.h)}" fill="${p.canvas}"/>\n` +
    layer('frames', pieces.frames) +
    layer('connections', pieces.connections) +
    layer('connection-labels', pieces.labels) +
    layer('cards', pieces.cards) +
    `</svg>\n`
  )
}

/** What a document of `area` holds, for the person and the tests. */
export function countIn(scene: Scene, area: Area) {
  const p = piecesIn(scene, area)
  return { cards: p.cards.length, frames: p.frames.length, connections: p.connections.length, labels: p.labels.length }
}
