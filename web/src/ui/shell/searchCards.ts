import type { CardVM } from '../../lib'

/** Case-insensitive match on title and summary; title matches first, then Board order. */
export function searchCards(cards: CardVM[], query: string, limit = 8): CardVM[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const byTitle: CardVM[] = []
  const bySummary: CardVM[] = []
  for (const c of cards) {
    if (c.title.toLowerCase().includes(q)) byTitle.push(c)
    else if (c.summary.toLowerCase().includes(q)) bySummary.push(c)
  }
  return [...byTitle, ...bySummary].slice(0, limit)
}
