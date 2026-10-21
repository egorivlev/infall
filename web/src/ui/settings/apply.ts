// Putting this device's settings into effect. Everything goes onto <html> as attributes and custom properties that
// the stylesheets read; nothing here knows about components.
//
// - Interface scale: `--q-ui-zoom` → `zoom` on <body> (base.css). The Board's canvas undoes it with `--q-ui-unzoom`
//   (board.css), so Cards are drawn at the Board's own scale and React Flow's pointer arithmetic sees no zoom at all.
// - Text size: `--q-text`, a factor every font size in the stylesheets is multiplied by.
// - Reduce motion: `data-motion="reduce" | "full"`; absent = follow the system (base.css, tutorial.css).
// - Theme: `data-theme`, as before (../shell/theme.ts).
// - Room: `data-room`, `--q-vw`, `--q-vh` — the window measured in interface pixels (below).
import { useEffect, useState } from 'react'
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
  applyRoom(p.interfaceScale, root)
}

// ---- Room: how wide the window is in the interface's own (zoomed) CSS pixels ----
//
// Media queries measure the window in unzoomed pixels, so at 150 % a 1280-pixel window would still count as wide while
// it holds only 853 pixels of interface. The shell therefore reads `data-room` on <html> instead, set from the window
// divided by the interface scale:
// - "wide"   ≥ 1100: the AI sidebar takes its own column.
// - "medium" 900–1099: the AI sidebar lies over the work area.
// - "narrow" < 900 (the desktop app's smallest window at 100 %): the rail folds to its icons as well, and opens over
//   the work area on demand.
// `--q-vw` / `--q-vh` are the window in the same pixels: inside the zoomed <body>, `100vw` is zoomed too and overshoots.
// index.html sets the same before the first paint.

export const ROOM_WIDE = 1100
export const ROOM_NARROW = 900
export type Room = 'wide' | 'medium' | 'narrow'

export function roomFor(interfaceWidth: number): Room {
  return interfaceWidth >= ROOM_WIDE ? 'wide' : interfaceWidth >= ROOM_NARROW ? 'medium' : 'narrow'
}

export function applyRoom(interfaceScale: number, root: HTMLElement = document.documentElement): Room {
  const k = 100 / interfaceScale
  // <html> is not zoomed: its client box is the window in plain CSS pixels. jsdom lays nothing out: use the window.
  const width = (root.clientWidth || window.innerWidth) * k
  const height = (root.clientHeight || window.innerHeight) * k
  const room = roomFor(width)
  root.setAttribute('data-room', room)
  root.style.setProperty('--q-vw', `${Math.floor(width)}px`)
  root.style.setProperty('--q-vh', `${Math.floor(height)}px`)
  return room
}

/** Applies the settings whenever they change (the theme's system-following is useThemeEffect's), and the room on resize. */
export function useAppliedPrefs(): void {
  useEffect(() => {
    applyPrefs(usePrefs.getState())
    const onResize = () => applyRoom(usePrefs.getState().interfaceScale)
    window.addEventListener('resize', onResize)
    const off = usePrefs.subscribe((p) => applyPrefs(p))
    return () => {
      off()
      window.removeEventListener('resize', onResize)
    }
  }, [])
}

/** The room right now, re-rendering when it changes (for what CSS alone cannot do, such as closing an overlay). */
export function useRoom(): Room {
  const [room, setRoom] = useState<Room>(() => currentRoom())
  useEffect(() => {
    const root = document.documentElement
    const update = () => setRoom(currentRoom())
    const watch = new MutationObserver(update)
    watch.observe(root, { attributes: true, attributeFilter: ['data-room'] })
    update()
    return () => watch.disconnect()
  }, [])
  return room
}

function currentRoom(): Room {
  const r = document.documentElement.getAttribute('data-room')
  return r === 'wide' || r === 'medium' || r === 'narrow' ? r : 'wide'
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
