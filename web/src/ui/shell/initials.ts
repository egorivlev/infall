/** "Ana Ruiz" -> "AR"; "Cher" -> "CH"; "" -> "?". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const first = words[0]
  if (!first) return '?'
  const last = words[words.length - 1] ?? first
  const chars =
    words.length > 1 ? [Array.from(first)[0], Array.from(last)[0]] : Array.from(first).slice(0, 2)
  return chars.join('').toUpperCase()
}
