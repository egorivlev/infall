// This device's settings: Appearance and Board. One versioned localStorage key, read synchronously at startup.
// Storage may be missing, blocked or hold anything: every read falls back to the defaults and nothing here throws.
// The OpenRouter key is not here and never will be: it stays on the server (AI access).
import { create } from 'zustand'

export type ThemePref = 'dark' | 'light' | 'system'
export type MotionPref = 'system' | 'reduce' | 'full'

export type Prefs = {
  theme: ThemePref
  /** The whole interface, in percent: chrome, panels, menus, Page text. Never the Board's drawing. */
  interfaceScale: number
  /** Text only, in percent of the interface's own sizes. */
  textSize: number
  reduceMotion: MotionPref
  /** How large the Board is drawn at its "100%", in percent. */
  boardScale: number
}

export const PREFS_KEY = 'infall-settings'
export const PREFS_VERSION = 1
/** Where the theme lived before Settings (M12 and earlier): read once, when the new key is not there yet. */
export const LEGACY_THEME_KEY = 'qoop-theme'

export const INTERFACE_SCALES = [80, 90, 100, 110, 125, 150] as const
export const TEXT_SIZES = [85, 90, 100, 110, 120, 130] as const
export const BOARD_SCALES = [60, 70, 80, 90, 100, 110, 125, 150, 175, 200] as const

export const DEFAULT_PREFS: Readonly<Prefs> = Object.freeze({
  theme: 'dark',
  interfaceScale: 100,
  textSize: 100,
  reduceMotion: 'system',
  boardScale: 100,
})

export function isThemePref(v: unknown): v is ThemePref {
  return v === 'dark' || v === 'light' || v === 'system'
}
function isMotionPref(v: unknown): v is MotionPref {
  return v === 'system' || v === 'reduce' || v === 'full'
}
function oneOf(steps: readonly number[], v: unknown, fallback: number): number {
  return typeof v === 'number' && steps.includes(v) ? v : fallback
}

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null // blocked (a sandboxed frame, a privacy setting)
  }
}

/** Whatever the store holds, made into settings: a field that is missing or not one of its values is its default. */
export function parsePrefs(raw: string | null, legacyTheme: string | null = null): Prefs {
  let data: unknown = null
  if (raw !== null) {
    try {
      data = JSON.parse(raw)
    } catch {
      data = null
    }
  }
  if (typeof data !== 'object' || data === null || (data as { v?: unknown }).v !== PREFS_VERSION) {
    // Nothing usable (or written by a later version this build does not know): defaults, keeping an earlier theme.
    return { ...DEFAULT_PREFS, theme: raw === null && isThemePref(legacyTheme) ? legacyTheme : DEFAULT_PREFS.theme }
  }
  const d = data as Record<string, unknown>
  return {
    theme: isThemePref(d.theme) ? d.theme : DEFAULT_PREFS.theme,
    interfaceScale: oneOf(INTERFACE_SCALES, d.interfaceScale, DEFAULT_PREFS.interfaceScale),
    textSize: oneOf(TEXT_SIZES, d.textSize, DEFAULT_PREFS.textSize),
    reduceMotion: isMotionPref(d.reduceMotion) ? d.reduceMotion : DEFAULT_PREFS.reduceMotion,
    boardScale: oneOf(BOARD_SCALES, d.boardScale, DEFAULT_PREFS.boardScale),
  }
}

export function readPrefs(): Prefs {
  const s = storage()
  if (!s) return { ...DEFAULT_PREFS }
  try {
    return parsePrefs(s.getItem(PREFS_KEY), s.getItem(LEGACY_THEME_KEY))
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export function writePrefs(p: Prefs): void {
  try {
    storage()?.setItem(PREFS_KEY, JSON.stringify({ v: PREFS_VERSION, ...p }))
  } catch {
    // full or blocked: the choice lasts for this page only
  }
}

export const usePrefs = create<Prefs>(() => readPrefs())

export const prefs = {
  get: (): Prefs => usePrefs.getState(),
  /** Changes some settings: applied at once and kept on this device. */
  set(patch: Partial<Prefs>): void {
    const next = { ...usePrefs.getState(), ...patch }
    writePrefs(next)
    usePrefs.setState(next, true)
  },
  reset(keys: (keyof Prefs)[]): void {
    const patch: Partial<Prefs> = {}
    for (const k of keys) Object.assign(patch, { [k]: DEFAULT_PREFS[k] })
    prefs.set(patch)
  },
  /** Test hook: read the store again. */
  reload(): void {
    usePrefs.setState(readPrefs(), true)
  },
}

/** The next Board scale up or down the steps, or the default for 0; the same value at either end. */
export function stepBoardScale(current: number, direction: 1 | -1 | 0): number {
  if (direction === 0) return DEFAULT_PREFS.boardScale
  const steps = BOARD_SCALES as readonly number[]
  const at = steps.indexOf(current)
  if (at === -1) {
    // Not a step (cannot come from the store, but be kind): the nearest step in that direction.
    const next = direction > 0 ? steps.find((s) => s > current) : [...steps].reverse().find((s) => s < current)
    return next ?? current
  }
  return steps[Math.max(0, Math.min(steps.length - 1, at + direction))] ?? current
}
