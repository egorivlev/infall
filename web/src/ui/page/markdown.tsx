// The Page's Markdown: a small, pure renderer from text to React elements.
//
// Supported, and nothing else: #/##/### headings, paragraphs, **bold**, *italic*, `code`, fenced
// code, "-" and "1." lists, "> " quotes, [text](http…) links, $inline$ and $$display$$ math.
// Anything else stays plain text. Text only ever becomes a React text node, so HTML typed into a
// Block is shown, never interpreted; the one exception is KaTeX's own output (see Tex.tsx).
//
// Every scan is bounded: a delimiter that found no partner is not searched for again, and nesting
// stops at MAX_DEPTH, so a hostile or simply huge line costs time linear in its length.
import type { ReactNode } from 'react'
import { Tex } from './Tex'

export type MdBlock =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; text: string; lang: string }
  | { type: 'math'; tex: string }
  | { type: 'list'; ordered: boolean; start: number; items: string[] }
  | { type: 'quote'; text: string }

const MAX_DEPTH = 6
const MAX_URL = 2048

const FENCE = /^```([^`]*)$/
const HEADING = /^(#{1,3})[ \t]+(\S.*)$/
const BULLET = /^-[ \t]+(.*)$/
const NUMBERED = /^(\d{1,9})\.[ \t]+(.*)$/
const CONTINUATION = /^(?: {2,}|\t)\s*\S/

const isBlank = (line: string) => line.trim() === ''
const isSpace = (ch: string | undefined) => ch === undefined || ch === ' ' || ch === '\t' || ch === '\n'
const isDigit = (ch: string | undefined) => ch !== undefined && ch >= '0' && ch <= '9'

/** Where a display formula opened by a lone `$$` on line `i` closes, or -1. */
function closingMathLine(lines: readonly string[], i: number): number {
  for (let j = i + 1; j < lines.length; j++) if (lines[j]!.trim() === '$$') return j
  return -1
}

function oneLineMath(line: string): string | null {
  const t = line.trim()
  if (t.length <= 4 || !t.startsWith('$$') || !t.endsWith('$$')) return null
  const tex = t.slice(2, -2)
  return tex.trim() === '' || tex.includes('$$') ? null : tex
}

/** Does this line start something other than a paragraph? */
function startsBlock(lines: readonly string[], i: number): boolean {
  const line = lines[i]!
  if (FENCE.test(line) || HEADING.test(line) || line.startsWith('>') || BULLET.test(line)) return true
  const numbered = NUMBERED.exec(line)
  if (numbered && numbered[1] === '1') return true // only "1." may interrupt a paragraph
  if (oneLineMath(line) !== null) return true
  return line.trim() === '$$' && closingMathLine(lines, i) !== -1
}

/** Splits the text of a Block into its block-level parts. Pure; never throws. */
export function parseBlocks(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const out: MdBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (isBlank(line)) {
      i++
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      let j = i + 1
      while (j < lines.length && lines[j]!.trimEnd() !== '```') j++
      out.push({ type: 'code', lang: fence[1]!.trim(), text: lines.slice(i + 1, j).join('\n') })
      i = j + 1 // an unclosed fence runs to the end, as it does while it is being typed
      continue
    }

    if (line.trim() === '$$') {
      const j = closingMathLine(lines, i)
      const tex = j === -1 ? '' : lines.slice(i + 1, j).join('\n')
      if (tex.trim() !== '') {
        out.push({ type: 'math', tex })
        i = j + 1
        continue
      }
    }
    const single = oneLineMath(line)
    if (single !== null) {
      out.push({ type: 'math', tex: single })
      i++
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      out.push({ type: 'heading', level: heading[1]!.length as 1 | 2 | 3, text: heading[2]!.trim() })
      i++
      continue
    }

    if (line.startsWith('>')) {
      const inner: string[] = []
      while (i < lines.length && lines[i]!.startsWith('>')) {
        inner.push(lines[i]!.replace(/^> ?/, ''))
        i++
      }
      out.push({ type: 'quote', text: inner.join('\n') })
      continue
    }

    const bullet = BULLET.exec(line)
    const numbered = bullet ? null : NUMBERED.exec(line)
    if (bullet || numbered) {
      const pattern = bullet ? BULLET : NUMBERED
      const items: string[] = []
      while (i < lines.length) {
        const m = pattern.exec(lines[i]!)
        if (m) items.push(m[m.length - 1]!)
        else if (items.length > 0 && CONTINUATION.test(lines[i]!)) items[items.length - 1] += `\n${lines[i]!.trim()}`
        else break
        i++
      }
      out.push({ type: 'list', ordered: !bullet, start: numbered ? Number(numbered[1]) : 1, items })
      continue
    }

    const para: string[] = [line]
    i++
    while (i < lines.length && !isBlank(lines[i]!) && !startsBlock(lines, i)) {
      para.push(lines[i]!)
      i++
    }
    out.push({ type: 'paragraph', text: para.join('\n') })
  }
  return out
}

/** The address a link may point at: http or https only. Everything else (javascript:, data:, …) is refused. */
export function safeHref(raw: string): string | null {
  const text = raw.trim()
  if (text.length > MAX_URL || !/^https?:\/\/[^\s/]/i.test(text)) return null
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

// ---- inline ----

const ESCAPABLE = '\\*`$[]()#>-'

/**
 * The closing `$` for inline math opened at `open`, or -1. Like Pandoc: the opening `$` must touch
 * the formula, the closing `$` must touch it too and must not be followed by a digit — so "$5 and
 * $10" is money, not math. The first `$` that cannot close ends the attempt.
 */
function closeMath(src: string, open: number): number {
  const first = src[open + 1]
  if (isSpace(first) || first === '$') return -1
  for (let j = open + 1; j < src.length; j++) {
    const ch = src[j]
    if (ch === '\\') j++
    else if (ch === '$') return !isSpace(src[j - 1]) && !isDigit(src[j + 1]) ? j : -1
  }
  return -1
}

/** Finds the closing `*` (width 1) or `**` (width 2) for emphasis whose content starts at `from`. */
function closeEmphasis(src: string, from: number, width: 1 | 2): number {
  let ticks = true
  for (let j = from; j < src.length; j++) {
    const ch = src[j]
    if (ch === '\\') {
      j++
    } else if (ch === '`' && ticks) {
      const end = src.indexOf('`', j + 1)
      if (end === -1) ticks = false
      else j = end
    } else if (ch === '$') {
      const end = closeMath(src, j)
      if (end !== -1) j = end
    } else if (ch === '*') {
      const double = src[j + 1] === '*'
      if (width === 1) {
        if (double) j++ // a ** pair belongs to bold inside the italic
        else if (j > from && !isSpace(src[j - 1])) return j
      } else if (double) {
        let end = j
        while (src[end + 2] === '*') end++ // in a run like ***, the last two close
        if (end > from && !isSpace(src[end - 1])) return end
        j = end + 1
      }
    }
  }
  return -1
}

type Link = { text: string; href: string; end: number }

/** `[text](url)` starting at `open`. The text may not contain brackets; the address may not contain spaces. */
function matchLink(src: string, open: number): Link | null {
  let close = -1
  for (let j = open + 1; j < src.length; j++) {
    const ch = src[j]
    if (ch === '\\') j++
    else if (ch === '[') return null
    else if (ch === ']') {
      close = j
      break
    }
  }
  if (close <= open + 1 || src[close + 1] !== '(') return null
  let depth = 0
  const limit = Math.min(src.length, close + 2 + MAX_URL)
  for (let k = close + 2; k < limit; k++) {
    const ch = src[k]
    if (isSpace(ch)) return null
    if (ch === '(') depth++
    else if (ch === ')') {
      if (depth === 0) {
        const href = safeHref(src.slice(close + 2, k))
        return href ? { text: src.slice(open + 1, close), href, end: k + 1 } : null
      }
      depth--
    }
  }
  return null
}

/** Inline Markdown to React nodes. `links: false` inside a link's own text. */
export function renderInline(src: string, depth = 0, links = true): ReactNode[] {
  const out: ReactNode[] = []
  let text = ''
  const flush = () => {
    if (text) out.push(text)
    text = ''
  }
  // Once a delimiter has found no partner, later ones of its kind will not either.
  const dead = { code: false, display: false, strong: false, em: false }
  const nest = depth < MAX_DEPTH
  let i = 0
  while (i < src.length) {
    const ch = src[i]!
    const next = src[i + 1]

    if (ch === '\\' && next !== undefined && ESCAPABLE.includes(next)) {
      text += next
      i += 2
      continue
    }

    if (ch === '`' && !dead.code) {
      const end = src.indexOf('`', i + 1)
      if (end === -1) dead.code = true
      else if (end > i + 1) {
        flush()
        out.push(<code key={out.length}>{src.slice(i + 1, end)}</code>)
        i = end + 1
        continue
      }
    }

    if (ch === '$' && next === '$') {
      const end = dead.display ? -1 : src.indexOf('$$', i + 2)
      if (end === -1) dead.display = true
      else if (src.slice(i + 2, end).trim() !== '') {
        flush()
        out.push(<Tex key={out.length} tex={src.slice(i + 2, end)} display />)
        i = end + 2
        continue
      }
      text += '$$'
      i += 2
      continue
    }
    if (ch === '$') {
      const end = closeMath(src, i)
      if (end !== -1) {
        flush()
        out.push(<Tex key={out.length} tex={src.slice(i + 1, end)} />)
        i = end + 1
        continue
      }
    }

    if (ch === '[' && links && nest) {
      const link = matchLink(src, i)
      if (link) {
        flush()
        out.push(
          <a key={out.length} href={link.href} target="_blank" rel="noreferrer noopener">
            {renderInline(link.text, depth + 1, false)}
          </a>,
        )
        i = link.end
        continue
      }
    }

    if (ch === '*') {
      const width = next === '*' ? 2 : 1
      const flag = width === 2 ? 'strong' : 'em'
      if (nest && !dead[flag] && !isSpace(src[i + width])) {
        const end = closeEmphasis(src, i + width, width)
        if (end === -1) dead[flag] = true
        else {
          flush()
          const inner = renderInline(src.slice(i + width, end), depth + 1, links)
          out.push(width === 2 ? <strong key={out.length}>{inner}</strong> : <em key={out.length}>{inner}</em>)
          i = end + width
          continue
        }
      }
      text += width === 2 ? '**' : '*'
      i += width
      continue
    }

    text += ch
    i++
  }
  flush()
  return out
}

function renderBlock(block: MdBlock, key: number, depth: number): ReactNode {
  switch (block.type) {
    case 'heading': {
      // The Page's <h1> is the Card title, so Markdown headings start one level down.
      const Tag = (['h2', 'h3', 'h4'] as const)[block.level - 1]!
      return (
        <Tag key={key} className={`qp-md__h qp-md__h${block.level}`}>
          {renderInline(block.text)}
        </Tag>
      )
    }
    case 'paragraph':
      return <p key={key}>{renderInline(block.text)}</p>
    case 'code':
      return (
        <pre key={key} data-lang={block.lang || undefined}>
          <code>{block.text}</code>
        </pre>
      )
    case 'math':
      return <Tex key={key} tex={block.tex} display />
    case 'list': {
      const items = block.items.map((item, n) => <li key={n}>{renderInline(item)}</li>)
      return block.ordered ? (
        <ol key={key} start={block.start === 1 ? undefined : block.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      )
    }
    case 'quote':
      return (
        <blockquote key={key}>
          {depth < MAX_DEPTH ? renderBlocks(block.text, depth + 1) : <p>{block.text}</p>}
        </blockquote>
      )
  }
}

function renderBlocks(source: string, depth: number): ReactNode[] {
  return parseBlocks(source).map((b, n) => renderBlock(b, n, depth))
}

/** The whole text of one Block as React elements. */
export function renderMarkdown(source: string): ReactNode[] {
  return renderBlocks(source, 0)
}
