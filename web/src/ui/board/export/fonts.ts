// The app's own fonts, embedded in an exported SVG as data: URLs — only the faces the picture uses, and of those
// only the subsets (Latin, Latin Extended, Greek: fonts.css) that hold a character it uses. A Board in Latin text
// takes about 100 KB of fonts; Greek adds about 15 KB per face, a Dead end Card's italic serif summary about 175 KB.
// An SVG drawn into a PNG can use no other fonts (an image cannot reach the page's), and a browser opening the file
// shows it exactly; Inkscape and Illustrator use the families by name with the fallbacks after them.
import { FACE_NAME } from './look'
import type { Family } from './look'
import type { FaceUse } from './svg'

/** One @font-face rule of the page. */
export type FaceRule = {
  family: string
  /** "400" or a range "400 600". */
  weight: string
  style: 'normal' | 'italic'
  url: string
  /** Inclusive code point ranges; everything when the rule has none. */
  ranges: Array<[number, number]>
  /** The rule's unicode-range as written, kept in the embedded rule. */
  rangeText: string
}

const ALL: Array<[number, number]> = [[0, 0x10ffff]]

/** "U+0000-00FF, U+0131, U+4??" → [[0, 255], [305, 305], [0x400, 0x4ff]]. */
export function parseUnicodeRange(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const part of text.split(',')) {
    const m = /^\s*u\+([0-9a-f?]+)(?:-([0-9a-f]+))?\s*$/i.exec(part)
    if (!m) continue
    const a = m[1]!
    if (a.includes('?')) out.push([parseInt(a.replace(/\?/g, '0'), 16), parseInt(a.replace(/\?/g, 'f'), 16)])
    else out.push([parseInt(a, 16), parseInt(m[2] ?? a, 16)])
  }
  return out.length ? out : ALL
}

function weightCovers(weight: string, w: number): boolean {
  const [lo, hi] = weight.trim().split(/\s+/).map((v) => (v === 'normal' ? 400 : v === 'bold' ? 700 : parseInt(v, 10)))
  if (lo === undefined || Number.isNaN(lo)) return w === 400
  return hi === undefined || Number.isNaN(hi) ? lo === w : lo <= w && w <= hi
}

function inRanges(cp: number, ranges: ReadonlyArray<[number, number]>): boolean {
  return ranges.some(([a, b]) => cp >= a && cp <= b)
}

/** The rules a picture needs: the right family, weight and style, and a range that holds one of its characters. */
export function chooseFaces(rules: readonly FaceRule[], use: FaceUse): FaceRule[] {
  const chosen = new Set<FaceRule>()
  for (const [key, chars] of use) {
    const [family, weight, italic] = key.split('-') as [Family, string, string | undefined]
    const name = FACE_NAME[family]
    const style = italic ? 'italic' : 'normal'
    const candidates = rules.filter((r) => r.family === name && r.style === style && weightCovers(r.weight, Number(weight)))
    for (const r of candidates) {
      if (chosen.has(r)) continue
      for (const cp of chars) {
        if (inRanges(cp, r.ranges)) {
          chosen.add(r)
          break
        }
      }
    }
  }
  return rules.filter((r) => chosen.has(r))
}

const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, '')

/** The @font-face rules of the page's own stylesheets for the app's three families. */
export function pageFaceRules(doc: Document = document): FaceRule[] {
  const names = new Set(Object.values(FACE_NAME))
  const out: FaceRule[] = []
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (typeof CSSFontFaceRule !== 'undefined' && rule instanceof CSSFontFaceRule) {
        const s = rule.style
        const family = unquote(s.getPropertyValue('font-family'))
        if (!names.has(family)) continue
        const url = /url\(\s*(["']?)([^"')]+)\1\s*\)/.exec(s.getPropertyValue('src'))?.[2]
        // Only the app's own files (and data: URLs): an export never carries a reference to another host.
        if (!url || (/^https?:/i.test(url) && !url.startsWith(location.origin))) continue
        const rangeText = s.getPropertyValue('unicode-range').trim()
        out.push({
          family,
          weight: s.getPropertyValue('font-weight').trim() || '400',
          style: s.getPropertyValue('font-style').trim() === 'italic' ? 'italic' : 'normal',
          url,
          ranges: rangeText ? parseUnicodeRange(rangeText) : ALL,
          rangeText,
        })
      } else if ('cssRules' in rule && rule.cssRules instanceof CSSRuleList) {
        visit(rule.cssRules) // @media, @supports, @layer
      }
    }
  }
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      visit(sheet.cssRules)
    } catch {
      // Another origin's stylesheet: not ours, and not readable.
    }
  }
  return out
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('The font could not be read.'))
    reader.readAsDataURL(blob)
  })
}

const fetched = new Map<string, Promise<string | null>>()

/** The file of one rule as a data: URL, fetched once per page. Null when it could not be had. */
function fontData(url: string): Promise<string | null> {
  let p = fetched.get(url)
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => (b ? dataUrl(new Blob([b], { type: 'font/woff2' })) : null))
      .catch(() => null)
    fetched.set(url, p)
  }
  return p
}

/** @font-face rules with the files inside, for the faces and characters `use` needs. "" when none could be had. */
export async function embeddedFontCss(use: FaceUse, rules: readonly FaceRule[] = pageFaceRules()): Promise<string> {
  const chosen = chooseFaces(rules, use)
  const parts = await Promise.all(
    chosen.map(async (r) => {
      const data = await fontData(r.url)
      if (!data) return ''
      const range = r.rangeText ? `unicode-range:${r.rangeText};` : ''
      return `@font-face{font-family:'${r.family}';font-style:${r.style};font-weight:${r.weight};src:url(${data}) format('woff2');${range}}`
    }),
  )
  return parts.filter(Boolean).join('\n')
}
