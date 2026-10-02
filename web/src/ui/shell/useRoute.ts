import { useMemo, useSyncExternalStore } from 'react'
import { currentPath, parseRoute, subscribeRoute } from './router'
import type { Route } from './router'

export function useRoute(): Route {
  const path = useSyncExternalStore(subscribeRoute, currentPath)
  return useMemo(() => parseRoute(path), [path])
}
