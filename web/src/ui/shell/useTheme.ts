import { useEffect, useSyncExternalStore } from 'react'
import { applyTheme, getThemePref, setThemePref, subscribeThemePref } from './theme'
import type { ThemePref } from './theme'

export function useThemePref(): [ThemePref, (p: ThemePref) => void] {
  const pref = useSyncExternalStore(subscribeThemePref, getThemePref)
  return [pref, setThemePref]
}

/** Applies the theme to <html> and follows the system setting while the preference is "system". */
export function useThemeEffect(): void {
  const [pref] = useThemePref()
  useEffect(() => {
    applyTheme(pref)
    if (pref !== 'system' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const on = () => applyTheme('system')
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [pref])
}
