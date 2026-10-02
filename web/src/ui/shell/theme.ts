// Theme preference: dark (default), light, or follow the system. Stored in localStorage; storage may be unavailable.
export type ThemePref = 'dark' | 'light' | 'system'
export const THEME_KEY = 'qoop-theme'
export const THEME_ORDER: ThemePref[] = ['dark', 'light', 'system']
export const THEME_LABEL: Record<ThemePref, string> = { dark: 'Dark', light: 'Light', system: 'Follow system' }

export function isThemePref(v: unknown): v is ThemePref {
  return v === 'dark' || v === 'light' || v === 'system'
}

export function readThemePref(): ThemePref {
  try {
    const v = window.localStorage.getItem(THEME_KEY)
    return isThemePref(v) ? v : 'dark'
  } catch {
    return 'dark'
  }
}

export function writeThemePref(pref: ThemePref): void {
  try {
    window.localStorage.setItem(THEME_KEY, pref)
  } catch {
    // storage unavailable: the choice lasts for this page only
  }
}

export function systemPrefersLight(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches
  } catch {
    return false
  }
}

export function resolveTheme(pref: ThemePref, prefersLight: boolean): 'dark' | 'light' {
  if (pref === 'system') return prefersLight ? 'light' : 'dark'
  return pref
}

export function applyTheme(pref: ThemePref): void {
  document.documentElement.setAttribute('data-theme', resolveTheme(pref, systemPrefersLight()))
}

export function nextThemePref(pref: ThemePref): ThemePref {
  return THEME_ORDER[(THEME_ORDER.indexOf(pref) + 1) % THEME_ORDER.length] ?? 'dark'
}

// A tiny shared store so the toggle and the root effect agree.
let current: ThemePref | null = null
const listeners = new Set<() => void>()

export function getThemePref(): ThemePref {
  current ??= readThemePref()
  return current
}

export function setThemePref(pref: ThemePref): void {
  current = pref
  writeThemePref(pref)
  applyTheme(pref)
  listeners.forEach((l) => l())
}

export function subscribeThemePref(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Test hook: forget the cached preference. */
export function resetThemeCache(): void {
  current = null
}
