/** "Ana Ruiz" → "Ana". */
export function firstName(name: string | undefined, fallback = 'Someone'): string {
  return name?.trim().split(/\s+/)[0] || fallback
}

/** "1 block", "3 Sources". */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * The name of whoever pinned or reviewed something, for a sentence: "Pinned by <name>".
 * Someone who is no longer in the Member list reads "a former Member". While the list is not there
 * at all (not loaded yet, or not given to this person) nobody can be called former: "a Member".
 */
export function memberName(list: readonly { id: string; name: string }[], id: string): { name: string; known: boolean } {
  const found = list.find((m) => m.id === id)
  if (found) return { name: found.name, known: true }
  return { name: list.length === 0 ? 'a Member' : 'a former Member', known: false }
}
