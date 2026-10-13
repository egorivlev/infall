// The Page of a Card and the Sources of the open Branch, read from the Board store (see board-sync.ts).
import { useStore } from 'zustand'
import { sync } from './board-sync'
import type { BlockVM, PageVM, SourceVM } from './types'

export { normalizeDoi, normalizeUrl } from './sources'
export { orderBetween } from './order'

/** Where the server hosts the sandboxed page a Visual runs in (api.md §13); the UI embeds it in an iframe. */
export const VISUAL_FRAME_PATH = '/visual-frame'

export const page = {
  startEditing: sync.startEditing,
  stopEditing: sync.stopEditing,
  findSource: sync.findSource,
}

// `sync.page` hands back the same object until that Page changes, so an edit elsewhere on the Board does not re-render.
export function usePage(cardId: string | null): PageVM {
  return useStore(sync.store, () => sync.page(cardId))
}

export function useSources(): SourceVM[] {
  return useStore(sync.store, (s) => s.pages.sources)
}

/**
 * A live Block of the open Board by its id, whichever Card's Page it is on (its `card` says which); undefined when
 * there is none. The same object comes back until that Block changes. M9: the Runner monitor names the Run in flight.
 */
export function useBlock(id: string | null): BlockVM | undefined {
  return useStore(sync.store, (s) => {
    if (id === null) return undefined
    for (const list of s.pages.blocks.values()) for (const b of list) if (b.id === id) return b
    return undefined
  })
}
