// LaTeX in BibTeX values, turned into the text a person reads: accents into real letters, the special
// characters BibTeX escapes into themselves, braces (which only protect case) dropped. Pure.
//
// Math between `$…$` is kept as it was written, dollars included: a Source title such as
// "Lower bounds for $\mathrm{SU}(2)$" reads better as TeX than as a guess.

/** Accent commands and the combining mark each puts on the letter after it. */
const ACCENTS: Record<string, string> = {
  "'": '́', // acute
  '`': '̀', // grave
  '^': '̂', // circumflex
  '"': '̈', // diaeresis
  '~': '̃', // tilde
  '=': '̄', // macron
  '.': '̇', // dot above
  u: '̆', // breve
  v: '̌', // caron
  H: '̋', // double acute
  c: '̧', // cedilla
  k: '̨', // ogonek
  r: '̊', // ring above
  d: '̣', // dot below
  b: '̱', // macron below
}

/** Commands that stand for one character (or a short piece of text) on their own. */
const SYMBOLS: Record<string, string> = {
  ss: 'ß',
  o: 'ø',
  O: 'Ø',
  ae: 'æ',
  AE: 'Æ',
  oe: 'œ',
  OE: 'Œ',
  aa: 'å',
  AA: 'Å',
  l: 'ł',
  L: 'Ł',
  i: 'ı',
  j: 'ȷ',
  dh: 'ð',
  DH: 'Ð',
  th: 'þ',
  TH: 'Þ',
  ng: 'ŋ',
  NG: 'Ŋ',
  textendash: '–',
  textemdash: '—',
  textbackslash: '\\',
  textbraceleft: '{',
  textbraceright: '}',
  textasciitilde: '~',
  textasciicircum: '^',
  textunderscore: '_',
  textbar: '|',
  textless: '<',
  textgreater: '>',
  textquoteleft: '‘',
  textquoteright: '’',
  textquotedblleft: '“',
  textquotedblright: '”',
  textregistered: '®',
  texttrademark: '™',
  copyright: '©',
  textcopyright: '©',
  textdegree: '°',
  S: '§',
  P: '¶',
  dag: '†',
  ddag: '‡',
  pounds: '£',
  euro: '€',
  ldots: '…',
  dots: '…',
  textellipsis: '…',
  LaTeX: 'LaTeX',
  TeX: 'TeX',
  BibTeX: 'BibTeX',
  space: ' ',
  quad: ' ',
  qquad: ' ',
  relax: '',
  protect: '',
  noopsort: '',
}

/** Commands whose one argument is the text itself: `\emph{word}` reads "word". */
const WRAPPERS = new Set([
  'emph',
  'textit',
  'textbf',
  'textsc',
  'textrm',
  'textsf',
  'texttt',
  'textup',
  'textsl',
  'textmd',
  'textnormal',
  'mbox',
  'hbox',
  'text',
  'url',
  'MakeUppercase',
  'MakeLowercase',
  'uppercase',
  'lowercase',
  'NoCaseChange',
  'bibinfo',
  'enquote',
])

/** Characters a backslash escapes into themselves. */
const ESCAPED = new Set(['&', '%', '$', '#', '_', '{', '}', ' ', ',', ';', ':', '!', '-', '/', '@'])

type Reader = { s: string; i: number }

/** The argument after an accent or wrapper: a braced group, or else one character (skipping spaces). */
function readArgument(r: Reader): string {
  while (r.s[r.i] === ' ') r.i++
  if (r.s[r.i] === '{') {
    let depth = 0
    const start = r.i + 1
    for (; r.i < r.s.length; r.i++) {
      const ch = r.s[r.i]
      if (ch === '\\') {
        r.i++
        continue
      }
      if (ch === '{') depth++
      else if (ch === '}' && --depth === 0) {
        const inner = r.s.slice(start, r.i)
        r.i++
        return inner
      }
    }
    return r.s.slice(start) // unbalanced: whatever is left
  }
  if (r.s[r.i] === '\\') {
    // An accent on a dotless letter: \'{\i} or \'\i.
    const m = /^\\([a-zA-Z]+)/.exec(r.s.slice(r.i))
    if (m) {
      r.i += m[0].length
      return SYMBOLS[m[1]!] ?? m[1]!
    }
  }
  const ch = r.s[r.i] ?? ''
  r.i += ch.length
  return ch
}

/** One letter with its accent; `{\i}` and `\i` lose their dot, as the accent replaces it. */
function accented(mark: string, arg: string): string {
  const base = convert(arg)
  if (base === '') return mark.normalize('NFC')
  const first = base === 'ı' ? 'i' : base === 'ȷ' ? 'j' : base[0]!
  return `${first}${mark}${base.slice(1)}`.normalize('NFC')
}

/** LaTeX to plain text, braces removed. Unknown commands keep their name, without the backslash. */
function convert(text: string): string {
  const r: Reader = { s: text, i: 0 }
  let out = ''
  while (r.i < r.s.length) {
    const ch = r.s[r.i]!
    if (ch === '$') {
      // Math: kept as written, up to the closing dollar(s).
      const double = r.s[r.i + 1] === '$'
      const fence = double ? '$$' : '$'
      const end = r.s.indexOf(fence, r.i + fence.length)
      if (end < 0) {
        out += r.s.slice(r.i)
        break
      }
      out += r.s.slice(r.i, end + fence.length)
      r.i = end + fence.length
      continue
    }
    if (ch === '{' || ch === '}') {
      r.i++
      continue
    }
    if (ch === '~') {
      out += ' '
      r.i++
      continue
    }
    if (ch === '-' && r.s.startsWith('---', r.i)) {
      out += '—'
      r.i += 3
      continue
    }
    if (ch === '-' && r.s.startsWith('--', r.i)) {
      out += '–'
      r.i += 2
      continue
    }
    if (ch === '`' && r.s[r.i + 1] === '`') {
      out += '“'
      r.i += 2
      continue
    }
    if (ch === "'" && r.s[r.i + 1] === "'") {
      out += '”'
      r.i += 2
      continue
    }
    if (ch !== '\\') {
      out += ch
      r.i++
      continue
    }
    // A command.
    const next = r.s[r.i + 1] ?? ''
    if (next in ACCENTS && !/[a-zA-Z]/.test(next)) {
      r.i += 2
      out += accented(ACCENTS[next]!, readArgument(r))
      continue
    }
    if (next === '\\') {
      out += ' '
      r.i += 2
      continue
    }
    if (ESCAPED.has(next)) {
      out += next === ' ' || next === ',' || next === ';' || next === ':' || next === '!' ? ' ' : next === '-' || next === '/' || next === '@' ? '' : next
      r.i += 2
      continue
    }
    const m = /^[a-zA-Z]+/.exec(r.s.slice(r.i + 1))
    if (!m) {
      r.i++
      continue
    }
    const name = m[0]
    r.i += 1 + name.length
    if (name.length === 1 && name in ACCENTS) {
      out += accented(ACCENTS[name]!, readArgument(r))
      continue
    }
    if (name in SYMBOLS) {
      // `\ss{}` and `\o{}`: the empty group only ends the command name.
      if (r.s.startsWith('{}', r.i)) r.i += 2
      else if (r.s[r.i] === ' ') r.i++
      out += SYMBOLS[name]
      continue
    }
    if (name === 'href') {
      // \href{address}{text}: the text is what reads.
      readArgument(r)
      out += convert(readArgument(r))
      continue
    }
    if (WRAPPERS.has(name)) {
      if (r.s[r.i] === ' ' || r.s[r.i] === '{') out += convert(readArgument(r))
      continue
    }
    // Unknown: its argument is kept as text when it has one, else its name, so nothing written vanishes.
    if (r.s[r.i] === '{') out += convert(readArgument(r))
    else out += name
  }
  return out
}

/** A BibTeX value (outer delimiters already removed) as plain text: LaTeX read, whitespace collapsed. */
export function latexToText(value: string): string {
  return convert(value).replace(/[\s ]+/g, ' ').trim()
}

/**
 * An address or a DOI from BibTeX: no LaTeX is read (a `~` in an address is a tilde), only `\url{…}`
 * unwrapped, escaped characters unescaped and braces dropped.
 */
export function latexToVerbatim(value: string): string {
  return value
    .replace(/\\(?:url|path|href)\s*\{([^{}]*)\}(?:\{[^{}]*\})?/g, '$1')
    .replace(/\\([_%#&$~])/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, '')
}
