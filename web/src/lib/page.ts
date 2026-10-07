// The Page of a Card and the Sources of the open Branch, read from the Board store (see board-sync.ts).
import { useStore } from 'zustand'
import { sync } from './board-sync'
import type { PageVM, SourceVM } from './types'

export { normalizeDoi, normalizeUrl } from './sources'
export { orderBetween } from './order'

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
