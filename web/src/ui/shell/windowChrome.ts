import { useSyncExternalStore } from 'react'
import type { QoopDesktop } from '../../lib'

/**
 * True in the macOS desktop app, whose window has no title bar of its own: the traffic lights are drawn over the left
 * end of the top bar's first row, which leaves room for them. The desktop app is known by the bridge it puts on the page.
 */
export function macDesktopWindow(): boolean {
  if (typeof navigator === 'undefined') return false
  const desktop = (globalThis as { qoopDesktop?: unknown }).qoopDesktop
  return typeof desktop === 'object' && desktop !== null && /Mac/.test(navigator.platform)
}

type Fullscreen = NonNullable<QoopDesktop['fullscreen']>

/** `window.qoopDesktop.fullscreen`, when it is there and has both functions. An older app, and every browser, has none. */
function desktopFullscreen(): Fullscreen | null {
  const desktop = (globalThis as { qoopDesktop?: { fullscreen?: unknown } }).qoopDesktop
  if (typeof desktop !== 'object' || desktop === null) return null
  const fs = desktop.fullscreen as Partial<Fullscreen> | null | undefined
  if (typeof fs !== 'object' || fs === null) return null
  if (typeof fs.current !== 'function' || typeof fs.subscribe !== 'function') return null
  return fs as Fullscreen
}

function subscribe(onChange: () => void): () => void {
  const fs = desktopFullscreen()
  if (fs === null) return () => {}
  try {
    const off: unknown = fs.subscribe(() => onChange())
    return typeof off === 'function' ? () => void off() : () => {}
  } catch {
    return () => {}
  }
}

function snapshot(): boolean {
  try {
    return desktopFullscreen()?.current() === true
  } catch {
    return false // a bridge that throws reads as not fullscreen: the room for the traffic lights stays
  }
}

/**
 * Whether the desktop window is in fullscreen (macOS then hides the traffic lights, so the top bar need not leave room
 * for them). Read from the bridge on the first render, so a window that opens in fullscreen never shows the gap.
 * False in a browser and in an app without `fullscreen`.
 */
export function useDesktopFullscreen(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false)
}
