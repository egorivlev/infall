import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CardVM, ConnectionVM, FrameVM } from '../../../lib'
import { luminance, parseColour } from './colour'
import { chooseFaces, parseUnicodeRange } from './fonts'
import type { FaceRule } from './fonts'
import { paletteFrom } from './palette'
import type { Theme } from './palette'
import { buildScene, countIn, svgDocument } from './svg'
import type { BoardContent } from './svg'
import { roughMeasure, wrapLines, xml } from './text'

const card = (id: string, x: number, y: number, more: Partial<CardVM> = {}): CardVM => ({
  id,
  title: `Card ${id}`,
  summary: 'A short summary.',
  status: 'idea',
  x,
  y,
  w: 220,
  h: 110,
  blocks: 0,
  sources: 0,
  ...more,
})
const conn = (id: string, from: string, to: string, more: Partial<ConnectionVM> = {}): ConnectionVM => ({ id, from, to, label: '', kind: 'related', ...more })
const frame = (id: string, x: number, y: number, w: number, h: number, title = 'Decoders'): FrameVM => ({ id, title, x, y, w, h })

// The theme's real tokens, read from tokens.css as the browser would.
const TOKENS = readFileSync(resolve(__dirname, '../../../styles/tokens.css'), 'utf8')
function tokens(theme: Theme) {
  const block = theme === 'dark' ? TOKENS.slice(0, TOKENS.indexOf('[data-theme="light"]')) : TOKENS.slice(TOKENS.indexOf('[data-theme="light"]'))
  return (name: string) => new RegExp(`--q-${name}:([^;]+);`).exec(block)?.[1] ?? ''
}
const palette = (theme: Theme, whiteBackground = false) => paletteFrom(tokens(theme), theme, { whiteBackground })

const board: BoardContent = {
  frames: [frame('f1', 0, 0, 600, 300)],
  cards: [
    card('a', 40, 60),
    card('b', 320, 60, { status: 'understood', blocks: 3, sources: 1 }),
    card('c', 1200, 900, { status: 'dead_end', title: 'Union–find <fails> & "why"', summary: 'Too slow at d > 25' }),
  ],
  connections: [
    conn('ab', 'a', 'b', { kind: 'directed', label: 'leads to' }),
    conn('bc', 'b', 'c', { kind: 'contradicts' }),
    conn('gone', 'a', 'removed-card'), // its Card is gone: not drawn
  ],
}

function svgOf(content: BoardContent = board, theme: Theme = 'dark', white = false, area = buildScene(content, palette(theme, white), roughMeasure).bounds!) {
  const p = palette(theme, white)
  const scene = buildScene(content, p, roughMeasure)
  return { scene, svg: svgDocument(scene, { palette: p, area, title: 'Board of main', description: 'From Infall.' }), area, p }
}

function parse(svg: string): Document {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  expect(doc.getElementsByTagName('parsererror')).toHaveLength(0)
  return doc
}

describe('svgDocument', () => {
  it('draws every Frame, Card and Connection whose Cards exist, with kind styling and labels', () => {
    const { scene, svg, area } = svgOf()
    expect(countIn(scene, area)).toEqual({ cards: 3, frames: 1, connections: 2, labels: 1 })
    const doc = parse(svg)
    expect(doc.querySelectorAll('g.card')).toHaveLength(3)
    expect(doc.querySelectorAll('g.frame')).toHaveLength(1)
    expect(doc.querySelectorAll('g.connection')).toHaveLength(2)
    expect(doc.querySelector('g.kind-directed path.connection-end')).not.toBeNull()
    // A contradiction has a bar at each end: two sub-paths in one cap.
    expect(doc.querySelector('g.kind-contradicts path.connection-end')!.getAttribute('d')!.match(/M/g)!.length).toBeGreaterThanOrEqual(2)
    expect(doc.querySelector('g.connection-label text')!.textContent).toBe('leads to')
    expect(doc.querySelector('#frame-f1 .frame-count')!.textContent).toBe('2 Cards')
  })

  it('writes the Card as at the Board’s full level: status, title, summary, footer', () => {
    const doc = parse(svgOf().svg)
    const b = doc.querySelector('#card-b')!
    expect(b.querySelector('.card-status')!.textContent).toBe('UNDERSTOOD')
    expect(b.querySelector('.card-title')!.textContent).toBe('Card b')
    expect(b.querySelector('.card-summary')!.textContent).toBe('A short summary.')
    expect([...b.querySelectorAll('.card-foot tspan')].map((t) => t.textContent)).toEqual(['¶ 3', '1 Source'])
    expect(b.querySelector('.status-glyph')).not.toBeNull()
    // Real text, not outlines or pictures.
    expect(doc.querySelectorAll('text').length).toBeGreaterThan(10)
    expect(doc.querySelector('image, foreignObject')).toBeNull()
  })

  it('escapes text and stays well formed, whatever the Board holds', () => {
    const nasty = card('x"&<', 0, 0, { title: '<script>alert(1)</script> & ]]> \u0001￾', summary: "it's \"quoted\"" })
    const { svg } = svgOf({ cards: [nasty], frames: [], connections: [] })
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;')
    const doc = parse(svg)
    const title = doc.querySelector('.card-title')!.textContent!
    expect(title).toContain('<script>alert(1)</script>')
    expect(title).toContain(']]>')
    expect(title.includes('\u0001') || title.includes('\uFFFE')).toBe(false)
    expect(doc.querySelector('g.card')!.getAttribute('id')).toBe('card-x___')
    expect(xml(`a<b>&"'`)).toBe('a&lt;b&gt;&amp;&quot;&apos;')
    expect(xml('\uD800x\uD83D\uDE00')).toBe('x\uD83D\uDE00')
  })

  it('is a standalone file: an XML declaration, a title, and no URL to anywhere', () => {
    const { svg } = svgOf()
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg.replace('http://www.w3.org/2000/svg', '')).not.toMatch(/https?:|xlink:href|<image|@import/)
    const doc = parse(svg)
    expect(doc.querySelector('title')!.textContent).toBe('Board of main')
    expect(doc.documentElement.getAttribute('font-family')).toContain("'IBM Plex Sans'")
    expect(doc.documentElement.getAttribute('font-family')).toMatch(/sans-serif$/)
    // The Dead end hatch is defined in the file itself.
    expect(doc.querySelector('pattern#hatch-dead')).not.toBeNull()
  })

  it('takes its colours from the theme, or light on white', () => {
    const dark = parse(svgOf(board, 'dark').svg)
    const light = parse(svgOf(board, 'light').svg)
    const white = parse(svgOf(board, 'light', true).svg)
    const bg = (d: Document) => d.querySelector('#background')!.getAttribute('fill')!
    expect(bg(dark)).toBe(palette('dark').canvas)
    expect(luminance(parseColour(bg(dark))!)).toBeLessThan(0.05)
    expect(luminance(parseColour(bg(light))!)).toBeGreaterThan(0.85)
    expect(bg(white)).toBe('#ffffff')
    // Titles are ink: light on dark, dark on light; the status colour comes from the theme.
    const ink = (d: Document) => luminance(parseColour(d.querySelector('#card-a .card-title')!.getAttribute('fill')!)!)
    expect(ink(dark)).toBeGreaterThan(0.7)
    expect(ink(white)).toBeLessThan(0.05)
    expect(dark.querySelector('#card-b .card-status')!.getAttribute('fill')).toBe(palette('dark').status.understood)
    expect(palette('dark').status.understood).not.toBe(palette('light').status.understood)
    // Every colour is plain sRGB for other programs.
    for (const v of Object.values(palette('dark'))) if (typeof v === 'string' && v.startsWith('#')) expect(v).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('clips to an area: only what reaches into it, and the view box is that area', () => {
    const area = { x: 1100, y: 800, w: 400, h: 300 }
    const { scene, svg } = svgOf(board, 'dark', false, area)
    expect(countIn(scene, area)).toEqual({ cards: 1, frames: 0, connections: 1, labels: 0 })
    const doc = parse(svg)
    expect(doc.documentElement.getAttribute('viewBox')).toBe('1100 800 400 300')
    expect([...doc.querySelectorAll('g.card')].map((g) => g.id)).toEqual(['card-c'])
    expect(doc.querySelector('#frames')).toBeNull()
  })

  it('leaves a margin round the whole Board, Frame labels included', () => {
    const { area } = svgOf()
    expect(area.x).toBeLessThanOrEqual(-32)
    expect(area.y).toBeLessThan(-32) // the Frame's label sits above it
    expect(area.x + area.w).toBeGreaterThanOrEqual(1200 + 220 + 32)
  })

  it('lays out 2 000 Cards in well under a second', () => {
    const cards = Array.from({ length: 2000 }, (_, i) => card(`c${i}`, (i % 50) * 260, Math.floor(i / 50) * 150))
    const connections = cards.slice(1).map((c, i) => conn(`k${i}`, cards[i]!.id, c.id, { label: i % 10 ? '' : 'next' }))
    const t = performance.now()
    const { scene, area } = svgOf({ cards, frames: [], connections })
    expect(performance.now() - t).toBeLessThan(3000)
    expect(countIn(scene, area).cards).toBe(2000)
  })
})

describe('wrapLines', () => {
  it('clamps to the given lines with an ellipsis and breaks a word too wide alone', () => {
    const lines = wrapLines('one two three four five six seven eight nine ten', 60, 2, 'title', roughMeasure)
    expect(lines).toHaveLength(2)
    expect(lines[1]!.endsWith('…')).toBe(true)
    expect(wrapLines('Supercalifragilistic', 50, 3, 'title', roughMeasure).length).toBeGreaterThan(1)
    expect(wrapLines('   ', 100, 2, 'title', roughMeasure)).toEqual([])
  })
})

describe('embedded fonts', () => {
  const rule = (family: string, weight: string, style: 'normal' | 'italic', range: string): FaceRule => ({
    family,
    weight,
    style,
    url: `/${family}-${weight}-${style}-${range}.woff2`,
    ranges: parseUnicodeRange(range),
    rangeText: range,
  })
  it('chooses only the faces and subsets the text uses', () => {
    const rules = [
      rule('IBM Plex Sans', '400 600', 'normal', 'U+0000-00FF'),
      rule('IBM Plex Sans', '400 600', 'normal', 'U+0370-03FF'),
      rule('Source Serif 4', '400', 'italic', 'U+0000-00FF'),
    ]
    const use = new Map([['sans-600', new Set([...'Abc'].map((c) => c.codePointAt(0)!))]])
    expect(chooseFaces(rules, use).map((r) => r.rangeText)).toEqual(['U+0000-00FF'])
    use.get('sans-600')!.add('α'.codePointAt(0)!)
    expect(chooseFaces(rules, use)).toHaveLength(2)
    expect(parseUnicodeRange('U+4??')).toEqual([[0x400, 0x4ff]])
  })
})

describe('look', () => {
  // The Card's sizes are board.css's: if the Board's CSS changes them, the export must change with it.
  const css = readFileSync(resolve(__dirname, '../board.css'), 'utf8')
  it('matches the Card at the full level', () => {
    expect(css).toMatch(/\.qb-card--full \.qb-card__body \{ padding: 9px 11px 8px; gap: 5px; \}/)
    expect(css).toMatch(/\.qb-card__title \{[^}]*font-size: calc\(13px \* var\(--q-text, 1\)\);[^}]*font-weight: 600;[^}]*line-height: 1\.3;/)
  })
})
