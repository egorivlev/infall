// M18: `@Name` in a Comment (pure). A mention is a Member's whole name after an "@" that starts a word; the ids
// sent with a Comment are worked out from the text, so what is mentioned is always what is written.
import type { Member } from './types'

type Named = Pick<Member, 'id' | 'name'>

const isWordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch)

/** Where each mention of a known Member stands in `text`, in order; the longest name wins where two would fit. */
export function mentionRanges(text: string, members: readonly Named[]): { start: number; end: number; member: string }[] {
  const named = members.filter((m) => m.name.trim() !== '').sort((a, b) => b.name.length - a.name.length)
  const out: { start: number; end: number; member: string }[] = []
  const lower = text.toLocaleLowerCase()
  for (let i = text.indexOf('@'); i >= 0; i = text.indexOf('@', i + 1)) {
    if (isWordChar(text[i - 1])) continue // an address like ana@lab.org
    for (const m of named) {
      const name = m.name.trim()
      const end = i + 1 + name.length
      if (lower.slice(i + 1, end) !== name.toLocaleLowerCase() || isWordChar(text[end])) continue
      out.push({ start: i, end, member: m.id })
      i = end - 1
      break
    }
  }
  return out
}

/** The Members a text mentions, by id, each once, in the order they first appear. */
export function findMentions(text: string, members: readonly Named[]): string[] {
  const ids: string[] = []
  for (const r of mentionRanges(text, members)) if (!ids.includes(r.member)) ids.push(r.member)
  return ids
}

/** At most this many characters are read after an "@" while completing (a name with a space or two fits). */
const MAX_QUERY = 40

/**
 * The mention being typed at `caret`: the "@" that starts it and what follows up to the caret, or null. The "@" must
 * start a word, and the query holds no line break and at most two spaces.
 */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0 || caret - at - 1 > MAX_QUERY) return null
  if (isWordChar(text[at - 1])) return null
  const query = before.slice(at + 1)
  if (/[\n\r@]/.test(query) || (query.match(/ /g)?.length ?? 0) > 2 || query.startsWith(' ')) return null
  return { start: at, query }
}

/**
 * Members whose name fits what is typed, best first: the name starting with it, then a later word starting with
 * it; then by name. Case does not matter. An empty query lists everyone (up to `limit`).
 */
export function mentionCandidates<T extends Named>(query: string, members: readonly T[], limit = 6): T[] {
  const q = query.toLocaleLowerCase()
  const scored: { m: T; rank: number }[] = []
  for (const m of members) {
    const name = m.name.toLocaleLowerCase()
    if (name.startsWith(q)) scored.push({ m, rank: 0 })
    else if (name.split(/\s+/).some((w, i) => i > 0 && w.startsWith(q)) || (q.includes(' ') && name.includes(q))) scored.push({ m, rank: 1 })
  }
  scored.sort((a, b) => a.rank - b.rank || a.m.name.localeCompare(b.m.name))
  return scored.slice(0, limit).map((s) => s.m)
}

/** Puts `@<name> ` in place of the mention being typed (from `start` to `caret`); returns the text and the caret after it. */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const after = text.slice(caret)
  const insert = `@${name}${after.startsWith(' ') ? '' : ' '}`
  return { text: text.slice(0, start) + insert + after, caret: start + insert.length + (after.startsWith(' ') ? 1 : 0) }
}
