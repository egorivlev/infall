// The page each PDF was left at, on this device (decision 7): one small map in localStorage, newest last, at most
// 200 PDFs. Storage may be missing or refuse (a private window, a full disk): then nothing is remembered.

export const PAGES_KEY = 'infall-pdf-pages'
const MAX = 200

type Stored = { v: 1; pages: [string, number][] }

function read(): [string, number][] {
  try {
    const raw = globalThis.localStorage?.getItem(PAGES_KEY)
    if (!raw) return []
    const s = JSON.parse(raw) as Stored
    if (s?.v !== 1 || !Array.isArray(s.pages)) return []
    return s.pages.filter((e): e is [string, number] => Array.isArray(e) && typeof e[0] === 'string' && Number.isInteger(e[1]) && e[1] > 0)
  } catch {
    return []
  }
}

/** The page `hash` was left at here, or null. */
export function rememberedPage(hash: string): number | null {
  const hit = read().find(([h]) => h === hash)
  return hit ? hit[1] : null
}

/** Notes that `hash` is at `page`; the oldest PDFs are forgotten beyond 200. */
export function rememberPage(hash: string, page: number): void {
  if (!Number.isInteger(page) || page < 1) return
  const pages = read().filter(([h]) => h !== hash)
  pages.push([hash, page])
  const kept = pages.slice(-MAX)
  try {
    globalThis.localStorage?.setItem(PAGES_KEY, JSON.stringify({ v: 1, pages: kept } satisfies Stored))
  } catch {
    // Not remembered; the reader works the same.
  }
}
