// A tiny history-API router: three paths, real links, back button.
export type Route = { name: 'board' } | { name: 'members' } | { name: 'invite'; token: string }

const NAV_EVENT = 'qoop:navigate'

export function parseRoute(pathname: string): Route {
  const path = pathname.split(/[?#]/)[0] ?? '/'
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 1 && parts[0] === 'members') return { name: 'members' }
  if (parts.length === 2 && parts[0] === 'invite' && parts[1]) {
    let token = parts[1]
    try {
      token = decodeURIComponent(token)
    } catch {
      // keep the raw segment
    }
    return { name: 'invite', token }
  }
  return { name: 'board' }
}

export function currentPath(): string {
  return window.location.pathname
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (to === window.location.pathname + window.location.search) return
  if (options.replace) window.history.replaceState(null, '', to)
  else window.history.pushState(null, '', to)
  window.dispatchEvent(new Event(NAV_EVENT))
}

export function subscribeRoute(listener: () => void): () => void {
  window.addEventListener('popstate', listener)
  window.addEventListener(NAV_EVENT, listener)
  return () => {
    window.removeEventListener('popstate', listener)
    window.removeEventListener(NAV_EVENT, listener)
  }
}
