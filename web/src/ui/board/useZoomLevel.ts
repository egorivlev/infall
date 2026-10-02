import { useViewportStore } from '@xyflow/react'
import { zoomLevel } from './geometry'
import type { ZoomLevel } from './geometry'

/** Semantic zoom level. Re-renders only when the level changes, not on every zoom tick. */
export function useZoomLevel(): ZoomLevel {
  return useViewportStore((s) => zoomLevel(s.transform[2]))
}
