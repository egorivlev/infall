// Find in document: matches in the stored text of each page, and their marks on the page's text layer. The text
// is the same that search uses (the server's `pdf_text`, or extracted here when there is none yet).

/** One match: page from 1, where it starts in that page's text, how long it is. */
export type Match = { page: number; index: number; length: number }

/** At most this many matches are counted; more read "1000+". */
export const MAX_MATCHES = 1000

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The pattern for what was typed: case ignored, any run of spaces or line breaks matches any other (a PDF breaks
 * lines where the typist did not). Null for a query that is only spaces.
 */
export function findPattern(query: string): RegExp | null {
  const words = query.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return null
  return new RegExp(words.map(escape).join('\\s+'), 'giu')
}

export function findMatches(pages: readonly string[], query: string, limit = MAX_MATCHES): Match[] {
  const re = findPattern(query)
  if (!re) return []
  const out: Match[] = []
  for (let p = 0; p < pages.length; p++) {
    const text = pages[p] ?? ''
    re.lastIndex = 0
    for (let m = re.exec(text); m; m = re.exec(text)) {
      out.push({ page: p + 1, index: m.index, length: m[0].length })
      if (out.length >= limit) return out
      if (m[0].length === 0) re.lastIndex++
    }
  }
  return out
}

/** The match to go to next (+1) or before (-1), round the end. -1 when there are none. */
export function stepMatch(count: number, current: number, dir: 1 | -1): number {
  if (count === 0) return -1
  if (current < 0) return dir > 0 ? 0 : count - 1
  return (current + dir + count) % count
}

/** The first match on page `page` or after it (round to the start), for a find that begins where the reader is. */
export function firstMatchFrom(matches: readonly Match[], page: number): number {
  if (matches.length === 0) return -1
  const i = matches.findIndex((m) => m.page >= page)
  return i < 0 ? 0 : i
}

/** Which of its page's matches `matches[i]` is (0 for the first on its page). */
export function ordinalOnPage(matches: readonly Match[], i: number): number {
  const m = matches[i]
  if (!m) return -1
  let k = 0
  for (let j = i - 1; j >= 0 && matches[j]!.page === m.page; j--) k++
  return k
}

/** "3 of 12", "1000+ matches", "No matches". */
export function matchLabel(count: number, current: number): string {
  if (count === 0) return 'No matches'
  const of = count >= MAX_MATCHES ? `${MAX_MATCHES}+` : String(count)
  return current >= 0 ? `${current + 1} of ${of}` : `${of} ${count === 1 ? 'match' : 'matches'}`
}

/** A short piece of `text` around `index`, on one line, with "…" where it was cut. */
export function snippetAt(text: string, index: number, length: number, radius = 40): string {
  const from = Math.max(0, index - radius)
  const to = Math.min(text.length, index + length + radius)
  const piece = text.slice(from, to).replace(/\s+/g, ' ').trim()
  return `${from > 0 ? '…' : ''}${piece}${to < text.length ? '…' : ''}`
}

export const MARK_CLASS = 'qr-hit'
export const ACTIVE_CLASS = 'is-active'

/**
 * Marks every occurrence of the query inside the text layer's spans (an occurrence split across two spans is
 * found by the counter but not marked: the text layer has no shared text node for it). Returns the marks in order.
 * Marks made before are taken out first, so this can run again for another query.
 */
export function markSpans(spans: readonly HTMLElement[], query: string): HTMLElement[] {
  for (const span of spans) {
    if (!span.querySelector(`mark.${MARK_CLASS}`)) continue
    span.textContent = span.textContent ?? ''
  }
  const re = findPattern(query)
  if (!re) return []
  const marks: HTMLElement[] = []
  for (const span of spans) {
    const text = span.textContent ?? ''
    re.lastIndex = 0
    let m = re.exec(text)
    if (!m) continue
    const doc = span.ownerDocument
    const parts: Node[] = []
    let at = 0
    for (; m; m = re.exec(text)) {
      if (m[0].length === 0) {
        re.lastIndex++
        continue
      }
      if (m.index > at) parts.push(doc.createTextNode(text.slice(at, m.index)))
      const mark = doc.createElement('mark')
      mark.className = MARK_CLASS
      mark.textContent = m[0]
      parts.push(mark)
      marks.push(mark)
      at = m.index + m[0].length
    }
    if (at < text.length) parts.push(doc.createTextNode(text.slice(at)))
    span.replaceChildren(...parts)
  }
  return marks
}
