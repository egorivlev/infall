// What is selected on the Branch Graph. Kept outside the screen so that coming back from "Preview the Board" finds
// the same dot selected; forgotten when the screen is left any other way.
import { create } from 'zustand'
import { useGraphPreview } from '../history/fromGraph'
import type { Selection } from './model'

export const useGraphSelection = create<{ sel: Selection | null }>(() => ({ sel: null }))

export const graphSelection = {
  set(sel: Selection | null) {
    useGraphSelection.setState({ sel })
  },
  clear() {
    useGraphSelection.setState({ sel: null })
  },
}

let mounted = 0

/**
 * Called when the screen mounts; returns what to call when it unmounts. The selection is forgotten once no screen is
 * left (checked after a tick, so that React's development double mount keeps it) unless a preview is under way.
 */
export function holdSelection(): () => void {
  mounted++
  return () => {
    mounted--
    setTimeout(() => {
      if (mounted === 0 && useGraphPreview.getState().current === null) graphSelection.clear()
    }, 0)
  }
}
