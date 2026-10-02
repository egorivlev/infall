import { useCallback } from 'react'
import { currentPath, navigate, parseRoute } from './router'

/** Runs a Board action; if the Members screen is showing, goes back to the Board first so the Board is mounted. */
export function useOnBoard(): (action: () => void) => void {
  return useCallback((action: () => void) => {
    if (parseRoute(currentPath()).name === 'board') return action()
    navigate('/')
    window.setTimeout(action, 60)
  }, [])
}
