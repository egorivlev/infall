/** "Ana Ruiz" → "Ana". */
export function firstName(name: string | undefined, fallback = 'Someone'): string {
  return name?.trim().split(/\s+/)[0] || fallback
}

/** "1 block", "3 Sources". */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}
