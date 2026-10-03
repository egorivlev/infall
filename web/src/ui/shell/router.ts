// A tiny history-API router: a handful of paths, real links, back button.
export type Route =
  | { name: 'board'; branch: string }
  | { name: 'branches' }
  | { name: 'members' }
  | { name: 'invite'; token: string }

export const MAIN = 'main'

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment // keep the raw text
  }
}

/** The Board of a Branch: `/` for main, `/b/<encoded name>` for any other. */
export function branchPath(name: string): string {
  return name === MAIN ? '/' : `/b/${encodeURIComponent(name)}`
}

// The Branch the Board last showed, so "back to the Board" returns there and not always to main.
let lastBranch = MAIN
export function rememberBranch(name: string): void {
  lastBranch = name
}
export function boardPath(): string {
  return branchPath(lastBranch)
}

const NAV_EVENT = 'qoop:navigate'

export function parseRoute(pathname: string): Route {
  const path = pathname.split(/[?#]/)[0] ?? '/'
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 1 && parts[0] === 'members') return { name: 'members' }
  if (parts.length === 1 && parts[0] === 'branches') return { name: 'branches' }
  if (parts.length === 2 && parts[0] === 'invite' && parts[1]) return { name: 'invite', token: decode(parts[1]) }
  if (parts[0] === 'b' && path.startsWith('/b/')) {
    // Names may contain "/": normally encoded, but a hand-typed /b/ana/fit works too. One trailing slash is not part of the name.
    const branch = decode(path.slice(3).replace(/\/$/, ''))
    if (branch) return { name: 'board', branch }
  }
  return { name: 'board', branch: MAIN }
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
