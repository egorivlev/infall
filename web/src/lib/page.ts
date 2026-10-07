// The Page of a Card and the Sources of the open Branch, read from the Board store (see board-sync.ts).
import { useStore } from 'zustand'
import { sync } from './board-sync'
import type { PageVM, SourceVM } from './types'

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
