// M18: words for a moved Local Workspace (team-move.md, decision 3), and the first screen of an empty Team server.
import { create } from 'zustand'

/** "lab.example.org" from "https://lab.example.org"; the text as it is when it is not an address. */
export function hostOf(origin: string): string {
  try {
    return new URL(origin).host || origin
  } catch {
    return origin
  }
}

/** The bar's line. Contract B gives no address: without `moved_to` the server stays unnamed. */
export function movedLine(movedTo: string | null): string {
  return movedTo ? `Moved to ${hostOf(movedTo)}. This copy is read-only.` : 'Moved to a Team server. This copy is read-only.'
}

/** The Kind line in Settings → Workspace. */
export function movedWords(movedTo: string | null): string {
  return movedTo ? `Local Workspace, moved to ${hostOf(movedTo)} — this copy is read-only` : 'Local Workspace, moved to a Team server — this copy is read-only'
}

/** The page cannot open the server itself: the desktop app's start screen can. */
export const OPEN_ON_SERVER_HINT = 'Goes back to the start screen, where this Workspace’s row has Open on the server.'

/** The first screen stays up after an import, so its answer can be read, until the Admin goes on to the Board. */
export const useFirstScreen = create<{ holding: boolean; imported?: boolean }>(() => ({ holding: false }))
// `imported`: a Workspace file was brought in in this window — its Admin knows Infall, so the Tour is not offered.

/** "830 KB", "2.4 MB", "1.1 GB"; "512 bytes". Powers of 1024, one decimal under 10. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)} ${Math.round(bytes) === 1 ? 'byte' : 'bytes'}`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)} ${units[u]}`
}
