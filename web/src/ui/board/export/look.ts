// How the Board looks at its 'full' level, in Board units, taken from board.css and StatusGlyph so that an exported
// Board matches the screen. Text size is the design's (Settings → Text size is a device setting, not part of the
// picture). If board.css changes the Card or Frame, change it here too: svg.test.ts ('look') holds the two side by side.
import type { Status } from '../../../lib'

export type Family = 'sans' | 'mono' | 'serif'

/** The font families written into the SVG: the app's own first, then what a computer without them is likely to have. */
export const FAMILY: Record<Family, string> = {
  sans: "'IBM Plex Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif",
  mono: "'IBM Plex Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace",
  serif: "'Source Serif 4', 'Source Serif Pro', Georgia, 'Times New Roman', serif",
}

/** The name each family has in the app's own @font-face rules (fonts.css). */
export const FACE_NAME: Record<Family, string> = {
  sans: 'IBM Plex Sans',
  mono: 'IBM Plex Mono',
  serif: 'Source Serif 4',
}

export type TextStyle = {
  family: Family
  weight: 400 | 500 | 600
  italic: boolean
  size: number
  /** Line height in Board units. */
  line: number
  letterSpacing?: number
}

/** Every kind of text on an exported Board. */
export const TEXT = {
  // .qb-card__status: 500 9.5px/1 mono, letter-spacing .07em, upper case
  status: { family: 'mono', weight: 500, italic: false, size: 9.5, line: 9.5, letterSpacing: 0.665 },
  // .qb-card__title: 600 13px/1.3, two lines
  title: { family: 'sans', weight: 600, italic: false, size: 13, line: 16.9 },
  // .qb-card__title.is-empty: 500
  titleEmpty: { family: 'sans', weight: 500, italic: false, size: 13, line: 16.9 },
  // .qb-card__summary: 11.5px/1.38, two lines
  summary: { family: 'sans', weight: 400, italic: false, size: 11.5, line: 15.87 },
  // .qb-card.is-dead .qb-card__summary: serif italic 12.5px
  deadSummary: { family: 'serif', weight: 400, italic: true, size: 12.5, line: 17.25 },
  // .qb-card__foot: 9.5px/1 mono
  foot: { family: 'mono', weight: 400, italic: false, size: 9.5, line: 9.5 },
  // .qb-frame__title: 600 15px/1
  frameTitle: { family: 'sans', weight: 600, italic: false, size: 15, line: 15 },
  // .qb-frame__count: mono .75em
  frameCount: { family: 'mono', weight: 400, italic: false, size: 11.25, line: 11.25 },
  // .qb-conn-label: 500 10.5px/1 mono
  label: { family: 'mono', weight: 500, italic: false, size: 10.5, line: 10.5 },
} as const satisfies Record<string, TextStyle>

export type TextKind = keyof typeof TEXT

/**
 * Where the baseline sits below the top of a line box, in em. IBM Plex has ascent 1.025 and descent 0.275 (together
 * 1.3 em); Source Serif 4 has 1.036 and 0.335. A line box of height `line` centres that content area on it.
 */
export function baseline(style: TextStyle): number {
  const [ascent, descent] = style.family === 'serif' ? [1.036, 0.335] : [1.025, 0.275]
  const halfLeading = (style.line - (ascent + descent) * style.size) / 2
  return halfLeading + ascent * style.size
}

/** The Card at its 'full' level (.qb-card, .qb-card--full). */
export const CARD = {
  radius: 5,
  border: 1,
  padTop: 9,
  padX: 11,
  padBottom: 8,
  gap: 5,
  topRow: 14,
  glyph: 10,
  glyphGap: 5,
  titleLines: 2,
  summaryLines: 2,
  footGap: 10,
} as const

/** The Frame (.qb-frame, .qb-frame__label). */
export const FRAME = {
  radius: 8,
  border: 1,
  labelLeft: 20,
  labelGap: 10, // between the label and the Frame's top edge
  countGap: 10, // between the title and the count
} as const

/** The Connection (.qb-conn__line, .qb-conn__cap, .qb-conn-label). */
export const CONNECTION = {
  width: 1.2,
  capWidth: 1.4,
  labelPadX: 6,
  labelPadY: 3,
  labelRadius: 3,
} as const

/** Room left around everything when the whole Board is exported. */
export const MARGIN = 32

type Paint = { fill?: boolean; stroked?: boolean; strokeWidth?: number }
export type Shape = ({ tag: 'path'; d: string } | { tag: 'circle'; cx: number; cy: number; r: number }) & Paint

/**
 * The status glyph (StatusGlyph.tsx) in its 10 × 10 box, stroke 1.3: `fill` shapes are filled with the status colour,
 * `stroked: false` ones are not outlined. ExportDialog.test.tsx renders StatusGlyph and compares.
 */
export const GLYPH: Record<Status, readonly Shape[]> = {
  idea: [{ tag: 'path', d: 'M5 1.2 L8.8 5 L5 8.8 L1.2 5 Z' }],
  reading: [
    { tag: 'circle', cx: 5, cy: 5, r: 3.8 },
    { tag: 'path', d: 'M5 1.2 A3.8 3.8 0 0 1 5 8.8 Z', fill: true, stroked: false },
  ],
  understood: [{ tag: 'circle', cx: 5, cy: 5, r: 3.8, fill: true }],
  open_question: [
    { tag: 'circle', cx: 5, cy: 5, r: 3.8 },
    { tag: 'path', d: 'M3.8 4 C3.8 2.7 6.2 2.7 6.2 4 C6.2 5 5 5 5 6', strokeWidth: 1.1 },
    { tag: 'circle', cx: 5, cy: 7.4, r: 0.6, fill: true, stroked: false },
  ],
  dead_end: [{ tag: 'path', d: 'M1.2 5 H7.4 M8.4 1.8 V8.2' }],
}
export const GLYPH_STROKE = 1.3
