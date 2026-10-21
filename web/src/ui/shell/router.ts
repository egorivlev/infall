// A tiny history-API router: a handful of paths, real links, back button.
export type Route =
  | { name: 'board'; branch: string }
  | { name: 'branches' }
  | { name: 'members' }
  | { name: 'todos' }
  | { name: 'settings'; section: SettingsSection }
  | { name: 'merge'; from: string; into: string }
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

/** The To-dos screen (Members and Admins; the same list on every Branch). */
export const TODOS_PATH = '/todos'

/** The sections of Settings, in the order they are listed. */
export const SETTINGS_SECTIONS = ['appearance', 'board', 'ai', 'runs', 'workspace', 'about'] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

function isSettingsSection(v: string | undefined): v is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(v ?? '')
}

/** Settings: `/settings` opens its first section, `/settings/<section>` that one. */
export const SETTINGS_PATH = '/settings'
export function settingsPath(section: SettingsSection): string {
  return `${SETTINGS_PATH}/${section}`
}

/** AI access, now the "AI access" section of Settings; the address it has always had still opens it. */
export const AI_ACCESS_PATH = '/settings/ai'

/** The Merge review of `from` into `into`. Names go in the query, each encoded on its own ("/", " ", "&", "+", "#" are all safe). */
export function mergePath(from: string, into: string): string {
  return `/merge?from=${encodeURIComponent(from)}&into=${encodeURIComponent(into)}`
}

/** One query parameter, decoded like a path segment (a "+" is a plus, a broken escape stays as typed). */
function queryParam(query: string, name: string): string {
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=')
    if (eq > 0 && decode(pair.slice(0, eq)) === name) return decode(pair.slice(eq + 1))
  }
  return ''
}

const NAV_EVENT = 'qoop:navigate'

/** Takes the path with its query (`/merge?from=…&into=…`); a hash is ignored. */
export function parseRoute(pathname: string): Route {
  const [path = '/', query = ''] = (pathname.split('#')[0] ?? '/').split('?')
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 1 && parts[0] === 'merge') {
    const from = queryParam(query, 'from')
    const into = queryParam(query, 'into')
    // Without both names there is nothing to review: the Branches screen is where a Merge starts.
    return from && into ? { name: 'merge', from, into } : { name: 'branches' }
  }
  if (parts.length === 1 && parts[0] === 'members') return { name: 'members' }
  if (parts.length === 1 && parts[0] === 'branches') return { name: 'branches' }
  if (parts.length === 1 && parts[0] === 'todos') return { name: 'todos' }
  if (parts.length === 1 && parts[0] === 'settings') return { name: 'settings', section: 'appearance' }
  if (parts.length === 2 && parts[0] === 'settings' && isSettingsSection(parts[1])) return { name: 'settings', section: parts[1] }
  if (parts.length === 2 && parts[0] === 'invite' && parts[1]) return { name: 'invite', token: decode(parts[1]) }
  if (parts[0] === 'b' && path.startsWith('/b/')) {
    // Names may contain "/": normally encoded, but a hand-typed /b/ana/fit works too. One trailing slash is not part of the name.
    const branch = decode(path.slice(3).replace(/\/$/, ''))
    if (branch) return { name: 'board', branch }
  }
  return { name: 'board', branch: MAIN }
}

/** Path and query: the Merge route keeps its two Branch names in the query. */
export function currentPath(): string {
  return window.location.pathname + window.location.search
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
