import { useCallback } from 'react'
import { boardPath, currentPath, navigate, parseRoute } from './router'

/** Runs a Board action; if another screen is showing, goes back to the Board (of the Branch that is open) first so the Board is mounted. */
export function useOnBoard(): (action: () => void) => void {
  return useCallback((action: () => void) => {
    if (parseRoute(currentPath()).name === 'board') return action()
    navigate(boardPath())
    window.setTimeout(action, 60)
  }, [])
}
