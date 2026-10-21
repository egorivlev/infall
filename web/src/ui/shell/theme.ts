// Theme preference: dark (default), light, or match the system. It is one of this device's settings (Settings →
// Appearance, ../settings/prefs.ts); the top bar's toggle and Settings change the same value.
import { LEGACY_THEME_KEY, PREFS_KEY, isThemePref, parsePrefs, prefs, usePrefs } from '../settings/prefs'
import type { ThemePref } from '../settings/prefs'

export type { ThemePref } from '../settings/prefs'
export { isThemePref } from '../settings/prefs'
/** Where the theme was kept before Settings; still read once when there are no settings yet. */
export const THEME_KEY = LEGACY_THEME_KEY
export const THEME_ORDER: ThemePref[] = ['dark', 'light', 'system']
export const THEME_LABEL: Record<ThemePref, string> = { dark: 'Dark', light: 'Light', system: 'Match system' }

/** The stored theme, read from storage now (settings first, then the key an earlier version used). */
export function readThemePref(): ThemePref {
  try {
    const s = window.localStorage
    return parsePrefs(s.getItem(PREFS_KEY), s.getItem(THEME_KEY)).theme
  } catch {
    return 'dark'
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

export function getThemePref(): ThemePref {
  return usePrefs.getState().theme
}

export function setThemePref(pref: ThemePref): void {
  if (!isThemePref(pref)) return
  prefs.set({ theme: pref })
  applyTheme(pref)
}

export function subscribeThemePref(l: () => void): () => void {
  return usePrefs.subscribe((s, was) => {
    if (s.theme !== was.theme) l()
  })
}

/** Test hook: read the stored settings again. */
export function resetThemeCache(): void {
  prefs.reload()
}
