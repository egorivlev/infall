// Text for an exported Board: wrapping into lines as the Board's CSS does (normal white space, words broken only
// when one alone is too wide, a clamp to N lines ending in "…"), escaping for XML, and measuring.
import { FACE_NAME, FAMILY, TEXT } from './look'
import type { TextKind, TextStyle } from './look'

/** The width of `text` in Board units when set in `kind`'s style. */
export type Measure = (text: string, kind: TextKind) => number

const ELLIPSIS = '…'

/** Splits off the longest start of `word` that fits in `max` (at least one character, so wrapping always moves on). */
function fitPrefix(word: string, max: number, kind: TextKind, measure: Measure): [string, string] {
  const chars = [...word]
  let n = 1
  while (n < chars.length && measure(chars.slice(0, n + 1).join(''), kind) <= max) n++
  return [chars.slice(0, n).join(''), chars.slice(n).join('')]
}

/** The text cut to fit `max` with "…" after it. */
function withEllipsis(line: string, max: number, kind: TextKind, measure: Measure): string {
  let chars = [...line.trimEnd()]
  while (chars.length > 0 && measure(chars.join('') + ELLIPSIS, kind) > max) chars = chars.slice(0, -1)
  return chars.join('').trimEnd() + ELLIPSIS
}

/**
 * The lines `text` takes in a box `max` wide, at most `maxLines` (the last ends in "…" when text is left over).
 * White space runs become one space, as `white-space: normal` does; a word wider than the box breaks anywhere
 * (`overflow-wrap: anywhere`). Line widths are the sum of their words and spaces, which is what the browser gives
 * to within kerning across a space.
 */
export function wrapLines(text: string, max: number, maxLines: number, kind: TextKind, measure: Measure): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  if (words.length === 0 || maxLines <= 0) return []
  const space = measure(' ', kind)
  const lines: string[] = []
  let line = ''
  let width = 0
  let i = 0
  let rest = words[0]!
  while (lines.length < maxLines) {
    const w = measure(rest, kind)
    if (line === '' && w > max) {
      // A word alone wider than the line: as much of it as fits, the rest on the next line.
      const [head, tail] = fitPrefix(rest, max, kind, measure)
      lines.push(head)
      rest = tail
      if (rest === '') {
        i++
        if (i >= words.length) return lines
        rest = words[i]!
      }
      continue
    }
    const next = line === '' ? w : width + space + w
    if (next <= max) {
      line = line === '' ? rest : `${line} ${rest}`
      width = next
      i++
      if (i >= words.length) {
        lines.push(line)
        return lines
      }
      rest = words[i]!
      continue
    }
    lines.push(line)
    line = ''
    width = 0
  }
  // Text is left over: the last line ends in an ellipsis.
  const last = lines.length - 1
  lines[last] = withEllipsis(lines[last]!, max, kind, measure)
  return lines
}

// Characters XML 1.0 does not allow at all (control characters other than tab and newlines, U+FFFE, U+FFFF, and
// lone surrogates); dropped from exported text so that the file is always well formed.
function xmlChar(ch: string): boolean {
  const cp = ch.codePointAt(0)!
  if (cp < 0x20) return cp === 0x09 || cp === 0x0a || cp === 0x0d
  if (cp >= 0xd800 && cp <= 0xdfff) return false // a lone surrogate (a pair is one character here)
  return cp !== 0xfffe && cp !== 0xffff
}

function onlyXml(text: string): string {
  let out = ''
  for (const ch of text) if (xmlChar(ch)) out += ch
  return out
}

/** Text for an XML element's content or an attribute value. */
export function xml(text: string): string {
  return onlyXml(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** A CSS `font` value for canvas measuring. */
export function cssFont(style: TextStyle): string {
  return `${style.italic ? 'italic ' : ''}${style.weight} ${style.size}px ${FAMILY[style.family]}`
}

/** The @font-face description the browser is asked to load before measuring (`document.fonts.load`). */
export function faceQuery(style: TextStyle, size = style.size): string {
  return `${style.italic ? 'italic ' : ''}${style.weight} ${size}px "${FACE_NAME[style.family]}"`
}

/**
 * A rough measure for where there is no canvas (tests, a browser refusing one): an average advance per character,
 * wider for the monospace face. Exact enough to wrap a title in about the right place.
 */
export const roughMeasure: Measure = (text, kind) => {
  const style: TextStyle = TEXT[kind]
  const per = style.family === 'mono' ? 0.6 : style.family === 'serif' ? 0.5 : 0.55
  return [...text].length * (style.size * per + (style.letterSpacing ?? 0))
}

/**
 * Measures with a 2D canvas in the page's own fonts (which must be loaded: see `loadFaces`). Words are measured once
 * each and remembered, so a Board of thousands of Cards costs a few thousand measurements, not one per line.
 */
export function canvasMeasure(): Measure {
  let ctx: CanvasRenderingContext2D | null = null
  try {
    ctx = document.createElement('canvas').getContext('2d')
  } catch {
    ctx = null
  }
  if (!ctx) return roughMeasure
  const context = ctx
  const caches = new Map<TextKind, Map<string, number>>()
  let font = ''
  return (text, kind) => {
    let cache = caches.get(kind)
    if (!cache) caches.set(kind, (cache = new Map()))
    const hit = cache.get(text)
    if (hit !== undefined) return hit
    const style: TextStyle = TEXT[kind]
    const want = cssFont(style)
    if (font !== want) context.font = font = want
    const w = context.measureText(text).width + (style.letterSpacing ?? 0) * [...text].length
    cache.set(text, w)
    return w
  }
}

/** Asks the browser for the faces the export measures with, so the measuring does not fall back to another font. */
export async function loadFaces(kinds: readonly TextKind[]): Promise<void> {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined
  if (!fonts || typeof fonts.load !== 'function') return
  const seen = new Set<string>()
  await Promise.all(
    kinds.map((k) => {
      const q = faceQuery(TEXT[k])
      if (seen.has(q)) return undefined
      seen.add(q)
      // Greek too, since physicists write it in titles; a face that is missing is simply not there.
      return fonts.load(q, 'Aαβ').catch(() => undefined)
    }),
  )
}
