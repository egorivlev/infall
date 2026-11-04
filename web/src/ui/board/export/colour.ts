// Colours for an exported Board. The theme's tokens are written in OKLCH (tokens.css); an SVG for Inkscape,
// Illustrator or a paper's toolchain needs plain sRGB, so they are converted here, and mixed where the Board's CSS
// mixes them (color-mix). Mixing is done in OKLab, which is what CSS does for `in oklab` and within a hair of
// `in oklch` for the near-grey tokens of the Board.

/** A colour in OKLab with its alpha (0–1). */
export type Colour = { L: number; a: number; b: number; alpha: number }

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055
}

function fromLinearRgb(r: number, g: number, b: number, alpha: number): Colour {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    alpha,
  }
}

function toLinearRgb({ L, a, b }: Colour): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

function num(part: string, percentOf = 1): number {
  const t = part.trim()
  return t.endsWith('%') ? (parseFloat(t) / 100) * percentOf : parseFloat(t)
}

/** The channels and alpha of `fn(c1 c2 c3 / a)` or `fn(c1, c2, c3, a)`. */
function channels(inner: string): { parts: string[]; alpha: number } | null {
  const [main = '', slash] = inner.split('/')
  const parts = main.trim().split(/[\s,]+/).filter(Boolean)
  let alpha = slash === undefined ? 1 : num(slash)
  if (slash === undefined && parts.length === 4) alpha = num(parts.pop()!)
  if (parts.length !== 3 || !Number.isFinite(alpha)) return null
  return { parts, alpha: clamp01(alpha) }
}

/** Reads `oklch(…)`, `oklab(…)`, `rgb(…)`/`rgba(…)` and `#rgb`/`#rrggbb`/`#rrggbbaa`. Null for anything else. */
export function parseColour(text: string): Colour | null {
  const t = text.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3,8})$/.exec(t)
  if (hex) {
    let h = hex[1]!
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('')
    if (h.length !== 6 && h.length !== 8) return null
    const v = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255
    return fromLinearRgb(srgbToLinear(v(0)), srgbToLinear(v(2)), srgbToLinear(v(4)), h.length === 8 ? v(6) : 1)
  }
  const fn = /^(oklch|oklab|rgba?)\((.*)\)$/.exec(t)
  if (!fn) return null
  const c = channels(fn[2]!)
  if (!c) return null
  const [p0, p1, p2] = c.parts as [string, string, string]
  if (fn[1] === 'oklch') {
    const L = num(p0)
    const C = num(p1, 0.4)
    const H = (parseFloat(p2) * Math.PI) / 180
    if (![L, C, H].every(Number.isFinite)) return null
    return { L, a: C * Math.cos(H), b: C * Math.sin(H), alpha: c.alpha }
  }
  if (fn[1] === 'oklab') {
    const [L, a, b] = [num(p0), num(p1, 0.4), num(p2, 0.4)]
    if (![L, a, b].every(Number.isFinite)) return null
    return { L, a, b, alpha: c.alpha }
  }
  const [r, g, b] = [num(p0, 255), num(p1, 255), num(p2, 255)].map((v) => v / 255) as [number, number, number]
  if (![r, g, b].every(Number.isFinite)) return null
  return fromLinearRgb(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), c.alpha)
}

/** `#rrggbb`, clipped into sRGB. The alpha is not in it: SVG takes it as `fill-opacity` / `stroke-opacity`. */
export function toHex(c: Colour): string {
  return (
    '#' +
    toLinearRgb(c)
      .map((v) => Math.round(clamp01(linearToSrgb(clamp01(v))) * 255))
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
  )
}

/** `color-mix(in oklab, a p, b)`: `p` (0–1) of `a`, the rest of `b`. */
export function mix(a: Colour, p: number, b: Colour): Colour {
  const q = 1 - p
  return { L: a.L * p + b.L * q, a: a.a * p + b.a * q, b: a.b * p + b.b * q, alpha: a.alpha * p + b.alpha * q }
}

/** sRGB relative luminance (WCAG), for tests of contrast and of which theme a palette is. */
export function luminance(c: Colour): number {
  const [r, g, b] = toLinearRgb(c).map(clamp01) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
