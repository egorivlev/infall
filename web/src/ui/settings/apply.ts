// Putting this device's settings into effect. Everything goes onto <html> as attributes and custom properties that
// the stylesheets read; nothing here knows about components.
//
// - Interface scale: `--q-ui-zoom` → `zoom` on <body> (base.css). The Board's canvas undoes it with `--q-ui-unzoom`
//   (board.css), so Cards are drawn at the Board's own scale and React Flow's pointer arithmetic sees no zoom at all.
// - Text size: `--q-text`, a factor every font size in the stylesheets is multiplied by.
// - Reduce motion: `data-motion="reduce" | "full"`; absent = follow the system (base.css, tutorial.css).
// - Theme: `data-theme`, as before (../shell/theme.ts).
import { useEffect } from 'react'
import { resolveTheme, systemPrefersLight } from '../shell/theme'
import { usePrefs } from './prefs'
import type { Prefs } from './prefs'

export function applyPrefs(p: Prefs, root: HTMLElement = document.documentElement): void {
  root.setAttribute('data-theme', resolveTheme(p.theme, systemPrefersLight()))
  root.style.setProperty('--q-ui-zoom', String(p.interfaceScale / 100))
  root.style.setProperty('--q-ui-unzoom', String(100 / p.interfaceScale))
  root.style.setProperty('--q-text', String(p.textSize / 100))
  if (p.reduceMotion === 'system') root.removeAttribute('data-motion')
  else root.setAttribute('data-motion', p.reduceMotion)
}

/** Applies the settings whenever they change (the theme's system-following is useThemeEffect's). */
export function useAppliedPrefs(): void {
  useEffect(() => {
    applyPrefs(usePrefs.getState())
    return usePrefs.subscribe((p) => applyPrefs(p))
  }, [])
}

/** Whether animation is welcome right now: the Settings choice, else the system's. */
export function motionAllowed(): boolean {
  const choice = usePrefs.getState().reduceMotion
  if (choice !== 'system') return choice === 'full'
  try {
    return !(typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  } catch {
    return true
  }
}

/**
 * How many CSS pixels of the zoomed interface one pixel of `getBoundingClientRect` is. Browsers that zoom the
 * standard way report rectangles in screen pixels while `left`/`top` of a fixed element are in zoomed CSS pixels;
 * measuring the ratio, instead of trusting the setting, keeps a browser that reports either way right.
 */
export function interfacePxPerScreenPx(el: Element = document.body): number {
  const width = el.getBoundingClientRect().width
  const css = (el as HTMLElement).clientWidth
  if (!width || !css) return 1
  const k = css / width
  return Number.isFinite(k) && k > 0 ? k : 1
}
