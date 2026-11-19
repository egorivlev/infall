// M19 (decision 8): Search Cards also finds Sources by the words in their PDF. The server answers places in stored
// PDF text by hash; this turns them into results on the open Branch — the Source with that PDF and a Card it is on.
import type { CardVM, PdfHit, SourceVM } from '../../lib'

export type PdfResult = {
  key: string
  hash: string
  page: number
  snippet: string
  sourceId: string
  sourceTitle: string
  fileName: string
  cardId: string
}

/** One result per page of a PDF, in the server's order, for the Sources of the open Branch that are on a live Card. */
export function pdfResults(hits: readonly PdfHit[], sources: readonly SourceVM[], cards: readonly CardVM[], limit = 6): PdfResult[] {
  const live = new Set(cards.map((c) => c.id))
  const byHash = new Map<string, SourceVM>()
  for (const s of sources) {
    if (!s.pdf || byHash.has(s.pdf)) continue
    if (s.cards.some((c) => live.has(c))) byHash.set(s.pdf, s)
  }
  const out: PdfResult[] = []
  const seen = new Set<string>()
  for (const h of hits) {
    const s = byHash.get(h.hash)
    const key = `${h.hash}:${h.page}`
    if (!s || seen.has(key)) continue
    seen.add(key)
    out.push({
      key,
      hash: h.hash,
      page: h.page,
      snippet: h.snippet.replace(/\s+/g, ' ').trim(),
      sourceId: s.id,
      sourceTitle: s.title || 'Untitled Source',
      fileName: s.pdfName || 'document.pdf',
      cardId: s.cards.find((c) => live.has(c))!,
    })
    if (out.length >= limit) break
  }
  return out
}

/** "in the PDF of <title>, page N", as screen readers and the result line say it. */
export function pdfResultText(r: Pick<PdfResult, 'sourceTitle' | 'page'>): string {
  return `in the PDF of ${r.sourceTitle}, page ${r.page}`
}

/**
 * The part of a snippet around the first place the query is found: the server sends up to 200 characters with the
 * match anywhere in them, and the result line shows one line, so the words found must be near its start. Cut at
 * word boundaries, with "…" where something was left out; the start of the snippet when the query is not in it.
 */
export function snippetAround(text: string, query: string, before = 24, max = 90): string {
  const words = query.trim().split(/\s+/).filter(Boolean)
  if (text.length <= max) return text
  const m = words.length ? queryPattern(words, 'iu').exec(text) : null
  if (!m) return `${text.slice(0, max).replace(/\s+\S*$/, '')}…`
  let start = Math.max(0, m.index - before)
  if (start > 0) {
    const space = text.lastIndexOf(' ', m.index - 1)
    if (space >= 0 && space >= start - 12) start = space + 1
  }
  let end = Math.max(start + max, m.index + m[0].length)
  if (end < text.length) {
    const space = text.indexOf(' ', end)
    if (space >= 0 && space - end < 12) end = space
  }
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`
}

function queryPattern(words: string[], flags: string): RegExp {
  return new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), flags)
}

/** The snippet in parts, the words of the query marked (case ignored), for <mark>. */
export function markedParts(text: string, query: string): { text: string; hit: boolean }[] {
  const words = query.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0 || !text) return [{ text, hit: false }]
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'giu')
  const parts: { text: string; hit: boolean }[] = []
  let at = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex++
      continue
    }
    if (m.index > at) parts.push({ text: text.slice(at, m.index), hit: false })
    parts.push({ text: m[0], hit: true })
    at = m.index + m[0].length
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false })
  return parts
}
