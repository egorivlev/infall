// The colours of an exported Board, taken from the theme's tokens (tokens.css) and turned into plain sRGB.
import type { Status } from '../../../lib'
import { mix, parseColour, toHex } from './colour'
import type { Colour } from './colour'

export type Theme = 'dark' | 'light'

/** Every colour the exported Board uses, as `#rrggbb` (with an opacity where the Board draws one). */
export type ExportPalette = {
  theme: Theme
  /** The Board's own background (`--q-canvas`); white for "Light background". */
  canvas: string
  frameFill: string
  frameLine: string
  frameTitle: string
  frameTitleEmpty: string
  frameCount: string
  card: string
  cardLine: string
  title: string
  titleEmpty: string
  summary: string
  foot: string
  status: Record<Status, string>
  /** A Dead end Card: tinted fill, softened border, a 135° hatch drawn at `deadHatchOpacity`. */
  deadFill: string
  deadLine: string
  deadHatch: string
  deadHatchOpacity: number
  connection: string
  connectionOpacity: number
  labelFill: string
  labelLine: string
  labelInk: string
}

const NAMES = [
  'canvas',
  'surface',
  'raised',
  'line-soft',
  'ink',
  'ink-2',
  'ink-3',
  'st-idea',
  'st-reading',
  'st-understood',
  'st-question',
  'st-dead',
] as const
type Token = (typeof NAMES)[number]

/** If a token cannot be read (a test without the stylesheet, a future token in a form not understood): neutral greys. */
const FALLBACK: Record<Theme, Record<Token, string>> = {
  dark: {
    canvas: '#1b1d20', surface: '#212327', raised: '#26292d', 'line-soft': '#33363b', ink: '#eceef1', 'ink-2': '#bcc0c5',
    'ink-3': '#93989e', 'st-idea': '#c3c6ca', 'st-reading': '#8fb4f0', 'st-understood': '#79d19c', 'st-question': '#e9c46a',
    'st-dead': '#bba493',
  },
  light: {
    canvas: '#f4f3f1', surface: '#faf9f8', raised: '#ffffff', 'line-soft': '#dddcd9', ink: '#24272c', 'ink-2': '#50545a',
    'ink-3': '#6a6e74', 'st-idea': '#5f6368', 'st-reading': '#2f5fae', 'st-understood': '#2f7a4f', 'st-question': '#9a6a14',
    'st-dead': '#77624f',
  },
}

/**
 * The palette from a way to read the theme's tokens (`raised` → the value of `--q-raised`). Pure: the export reads the
 * live stylesheet with `readPalette`, the tests read tokens.css itself.
 */
export function paletteFrom(token: (name: Token) => string, theme: Theme, opts: { whiteBackground?: boolean } = {}): ExportPalette {
  const c = {} as Record<Token, Colour>
  for (const name of NAMES) c[name] = parseColour(token(name)) ?? parseColour(FALLBACK[theme][name])!
  const canvas = opts.whiteBackground ? parseColour('#ffffff')! : c.canvas
  const hex = (name: Token) => toHex(c[name])
  return {
    theme,
    canvas: toHex(canvas),
    // .qb-frame: color-mix(in oklch, var(--q-canvas) 55%, var(--q-surface)) — from the Board's canvas, not the page's white.
    frameFill: toHex(mix(c.canvas, 0.55, c.surface)),
    frameLine: hex('line-soft'),
    frameTitle: hex('ink'),
    frameTitleEmpty: hex('ink-3'),
    frameCount: hex('ink-3'),
    card: hex('raised'),
    cardLine: hex('line-soft'),
    title: hex('ink'),
    titleEmpty: hex('ink-3'),
    summary: hex('ink-2'),
    foot: hex('ink-3'),
    status: {
      idea: hex('st-idea'),
      reading: hex('st-reading'),
      understood: hex('st-understood'),
      open_question: hex('st-question'),
      dead_end: hex('st-dead'),
    },
    // .qb-card.is-dead: 5% of the status colour in the fill, 45% in the border, a 9% hatch.
    deadFill: toHex(mix(c['st-dead'], 0.05, c.raised)),
    deadLine: toHex(mix(c['st-dead'], 0.45, c['line-soft'])),
    deadHatch: hex('st-dead'),
    deadHatchOpacity: 0.09,
    connection: hex('ink-3'),
    connectionOpacity: 0.6,
    labelFill: toHex(canvas),
    labelLine: hex('line-soft'),
    labelInk: hex('ink-2'),
  }
}

/**
 * The palette of `theme` as this page's stylesheet has it: a hidden element carrying `data-theme` is asked for the
 * tokens, so a light palette can be read while the app is dark.
 */
export function readPalette(theme: Theme, opts: { whiteBackground?: boolean } = {}): ExportPalette {
  const probe = document.createElement('div')
  probe.setAttribute('data-theme', theme)
  probe.setAttribute('aria-hidden', 'true')
  probe.style.display = 'none'
  document.body.appendChild(probe)
  try {
    const style = getComputedStyle(probe)
    return paletteFrom((name) => style.getPropertyValue(`--q-${name}`), theme, opts)
  } finally {
    probe.remove()
  }
}

/** The theme the app shows now. */
export function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
}
