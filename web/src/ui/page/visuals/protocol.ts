// The parent side of the Visual frame protocol (docs/specs/api.md §13), as pure functions: what a
// message from the frame may look like, how tall a frame may be, and which colours it is given.
// Nothing here touches a frame, so all of it is tested without one.

export const DEFAULT_HEIGHT = 240
export const MIN_HEIGHT = 80
export const MAX_HEIGHT = 900
export const MAX_ERROR_LENGTH = 300

export type FrameMessage = { type: 'ready' } | { type: 'height'; value: number } | { type: 'error'; message: string }

export type RenderMessage = { infall: 'visual'; type: 'render'; html: string; theme: Record<string, string> }

/** 80–900 whole pixels; anything that is not a finite number gives the default. */
export function clampHeight(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_HEIGHT
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(value)))
}

/** One line of plain text, at most 300 characters. It is only ever shown as text. */
export function cleanError(message: string): string {
  let line = ''
  for (const ch of message.slice(0, MAX_ERROR_LENGTH * 4)) {
    const code = ch.codePointAt(0) ?? 0
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
    line += control ? ' ' : ch
  }
  line = line.replace(/ {2,}/g, ' ').trim()
  return line.slice(0, MAX_ERROR_LENGTH) || 'Unknown error'
}

/**
 * What a message from the frame says, or null when it is not one of ours: not an object, not
 * tagged `infall: "visual"`, an unknown type, a `height` that is not a finite number, an `error`
 * whose message is not a string. The caller has already checked where it came from.
 */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const m = data as Record<string, unknown>
  if (m.infall !== 'visual') return null
  switch (m.type) {
    case 'ready':
      return { type: 'ready' }
    case 'height':
      return typeof m.value === 'number' && Number.isFinite(m.value) ? { type: 'height', value: clampHeight(m.value) } : null
    case 'error':
      return typeof m.message === 'string' ? { type: 'error', message: cleanError(m.message) } : null
    default:
      return null
  }
}

/** The colour variables a Visual is given. Templates use these names and no others. */
export const THEME_KEYS = [
  '--q-ink',
  '--q-ink-2',
  '--q-ink-3',
  '--q-line',
  '--q-line-soft',
  '--q-accent',
  '--q-accent-soft',
  '--q-accent-ink',
  '--q-surface',
  '--q-raised',
  '--q-sunken',
  '--q-hover',
  '--q-danger',
  '--q-st-idea',
  '--q-st-reading',
  '--q-st-understood',
  '--q-st-question',
  '--q-st-dead',
] as const

const UNSAFE_VALUE = /[;{}<]/

/**
 * The `theme` of a `render` message: every colour variable that has a value, plus `color-scheme`.
 * Values the frame would drop anyway (`;`, `{`, `}`, `<`) are left out here already.
 */
export function collectTheme(read: (name: string) => string, colorScheme: string): Record<string, string> {
  const theme: Record<string, string> = {}
  for (const key of THEME_KEYS) {
    const value = read(key).trim()
    if (value && !UNSAFE_VALUE.test(value)) theme[key] = value
  }
  theme['color-scheme'] = colorScheme === 'light' ? 'light' : 'dark'
  return theme
}

/** The app's current colours, read from the document (`data-theme` on the root decides light or dark). */
export function readTheme(root: HTMLElement = document.documentElement): Record<string, string> {
  const style = getComputedStyle(root)
  return collectTheme((name) => style.getPropertyValue(name), root.getAttribute('data-theme') === 'light' ? 'light' : 'dark')
}

export function renderMessage(html: string, theme: Record<string, string>): RenderMessage {
  return { infall: 'visual', type: 'render', html, theme }
}
