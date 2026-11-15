// A BibTeX reader: what Zotero, Mendeley, JabRef, Google Scholar and arXiv export. Pure.
//
// It reads `@type{key, field = value, …}` (or with parentheses), values in braces or quotes with nested
// braces, bare numbers, `@string` abbreviations (and the month names) joined with `#`. `@comment` and
// `@preamble` are skipped, and so is everything outside an entry, as in BibTeX. Braces are counted the way
// BibTeX counts them: every one counts, a backslash in front or not.
//
// An entry that cannot be read is not dropped in silence: it is listed in `problems` with its line and a
// sentence saying what is wrong, and reading carries on at the next entry.
import { latexToText, latexToVerbatim } from './latex'

/** One reference, as the Source fields want it. Every field is plain text; '' when the entry has none. */
export type BibEntry = {
  /** The entry's key, e.g. `jerbi2021parametrized`. */
  key: string
  /** The entry type, lower-case: `article`, `misc`, `inproceedings`… */
  type: string
  /** The line the entry starts on, counted from 1. */
  line: number
  title: string
  /** In the Source field's form: "Sofiene Jerbi, Vedran Dunjko" ("…, et al." when the list ends in "others"). */
  authors: string
  year: string
  doi: string
  url: string
  note: string
  /** M19: the `file` field as written (Zotero's files; read by fileField.ts); absent when the entry has none. */
  file?: string
}

export type BibProblem = { line: number; key: string; reason: string }

export type BibParse = { entries: BibEntry[]; problems: BibProblem[] }

const MONTHS: Record<string, string> = {
  jan: 'January',
  feb: 'February',
  mar: 'March',
  apr: 'April',
  may: 'May',
  jun: 'June',
  jul: 'July',
  aug: 'August',
  sep: 'September',
  oct: 'October',
  nov: 'November',
  dec: 'December',
}

const SKIPPED = new Set(['comment', 'preamble'])
const NAME = /[^\s"#%'(),={}]/

class Unreadable extends Error {}

/** Turns an index into a line number, moving forward only (entries are read in order). */
function lineCounter(text: string) {
  let at = 0
  let line = 1
  return (index: number): number => {
    for (; at < index && at < text.length; at++) if (text.charCodeAt(at) === 10) line++
    return line
  }
}

class Scanner {
  readonly s: string
  i: number
  constructor(s: string, start: number) {
    this.s = s
    this.i = start
  }
  skipSpace() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++
  }
  peek(): string {
    return this.s[this.i] ?? ''
  }
  name(): string {
    const start = this.i
    while (this.i < this.s.length && NAME.test(this.s[this.i]!)) this.i++
    return this.s.slice(start, this.i)
  }
  /** A `{…}` group starting here; returns what is inside. */
  braced(): string {
    const start = this.i + 1
    let depth = 0
    for (; this.i < this.s.length; this.i++) {
      const ch = this.s[this.i]
      if (ch === '{') depth++
      else if (ch === '}' && --depth === 0) {
        this.i++
        return this.s.slice(start, this.i - 1)
      }
    }
    throw new Unreadable('a brace is opened and never closed')
  }
  /** A `"…"` value starting here: it ends at a quote outside braces. */
  quoted(): string {
    const start = this.i + 1
    let depth = 0
    for (this.i++; this.i < this.s.length; this.i++) {
      const ch = this.s[this.i]
      if (ch === '{') depth++
      else if (ch === '}') {
        if (--depth < 0) throw new Unreadable('a closing brace has no opening one')
      } else if (ch === '"' && depth === 0) {
        this.i++
        return this.s.slice(start, this.i - 1)
      }
    }
    throw new Unreadable('a quotation mark is opened and never closed')
  }
}

/** One value: parts joined with `#`, abbreviations replaced. Braces inside are kept for the field readers. */
function readValue(sc: Scanner, macros: ReadonlyMap<string, string>): string {
  let value = ''
  for (;;) {
    sc.skipSpace()
    const ch = sc.peek()
    if (ch === '{') value += sc.braced()
    else if (ch === '"') value += sc.quoted()
    else if (/[0-9]/.test(ch)) {
      const start = sc.i
      while (/[0-9]/.test(sc.peek())) sc.i++
      value += sc.s.slice(start, sc.i)
    } else {
      const name = sc.name()
      if (name === '') throw new Unreadable(ch === '' ? 'the file ends inside it' : `a value is missing before “${ch}”`)
      const lower = name.toLowerCase()
      // An abbreviation nobody defined reads as empty, as in BibTeX.
      value += macros.get(lower) ?? MONTHS[lower] ?? ''
    }
    sc.skipSpace()
    if (sc.peek() !== '#') return value
    sc.i++
  }
}

/** Splits at `sep` where it stands outside braces. */
function splitOutside(text: string, sep: RegExp): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') depth++
    else if (ch === '}') depth = Math.max(0, depth - 1)
    else if (depth === 0) {
      sep.lastIndex = i
      const m = sep.exec(text)
      if (m && m.index === i) {
        parts.push(text.slice(start, i))
        i += m[0].length - 1
        start = i + 1
      }
    }
  }
  parts.push(text.slice(start))
  return parts
}

const AND = /\s+and\s+/iy
const COMMA = /,/y

/** "Jerbi, Sofiene" and "Sofiene Jerbi" → "Sofiene Jerbi"; "von Neumann, Jr., John" → "John von Neumann Jr.". */
function personName(raw: string): string {
  const parts = splitOutside(raw, COMMA).map((p) => latexToText(p))
  if (parts.length === 1) return parts[0]!
  const [last, second, third] = parts
  const given = parts.length >= 3 ? third : second
  const jr = parts.length >= 3 ? second : ''
  return [given, last, jr].filter((p) => p !== '' && p !== undefined).join(' ')
}

/** BibTeX's `author` list in the Source field's form. */
export function readAuthors(raw: string): string {
  const names = splitOutside(raw.trim(), AND)
    .map((n) => n.trim())
    .filter((n) => n !== '')
  const others = names.length > 0 && names[names.length - 1]!.toLowerCase() === 'others'
  const people = (others ? names.slice(0, -1) : names).map(personName).filter((n) => n !== '')
  const list = people.join(', ')
  // The form Look up answers with too: "…, et al." (docs/specs/api.md §17).
  return others ? (list ? `${list}, et al.` : 'et al.') : list
}

const ARXIV_ID = /(?:arxiv[:\s/]*)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/i

/** The parts of an entry the Source fields use. Fields keep the first of two with the same name. */
function toEntry(type: string, key: string, line: number, fields: ReadonlyMap<string, string>): BibEntry {
  const text = (name: string) => latexToText(fields.get(name) ?? '')
  const verbatim = (name: string) => latexToVerbatim(fields.get(name) ?? '')

  const yearText = text('year')
  const year = /\b\d{4}\b/.exec(yearText)?.[0] ?? (yearText || (/^\s*(\d{4})/.exec(text('date'))?.[1] ?? ''))

  let doi = verbatim('doi').replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '')
  let url = verbatim('url')
  if (doi === '' && /^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i.test(url)) {
    doi = url.replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, '')
    url = ''
  }
  if (url === '') {
    // arXiv's own export and biblatex: eprint + archivePrefix (or eprinttype) = arXiv.
    const prefix = `${text('archiveprefix')} ${text('eprinttype')}`.toLowerCase()
    const eprint = verbatim('eprint')
    if (eprint && prefix.includes('arxiv')) url = `https://arxiv.org/abs/${eprint}`
  }
  if (url === '') {
    // Google Scholar: journal = {arXiv preprint arXiv:2103.05577}.
    const journal = text('journal')
    const m = /arxiv/i.test(journal) ? ARXIV_ID.exec(journal) : null
    if (m) url = `https://arxiv.org/abs/${m[1]}`
  }
  if (url === '') {
    const m = /https?:\/\/[^\s{}]+/.exec(latexToVerbatim(fields.get('howpublished') ?? ''))
    if (m) url = m[0]
  }

  const authors = fields.has('author') ? readAuthors(fields.get('author')!) : fields.has('editor') ? readAuthors(fields.get('editor')!) : ''
  const entry: BibEntry = { key, type, line, title: text('title'), authors, year, doi, url, note: text('note') }
  const file = fields.get('file')
  if (file !== undefined && file.trim() !== '') entry.file = file
  return entry
}

/** Whether only spaces or tabs stand between the start of its line and `index`. */
function atLineStart(text: string, index: number): boolean {
  for (let j = index - 1; j >= 0; j--) {
    const ch = text[j]
    if (ch === '\n') return true
    if (ch !== ' ' && ch !== '\t') return false
  }
  return true
}

/** Where to carry on after an entry that could not be read: the next `@` at the start of a line. */
function nextEntryStart(text: string, from: number): number {
  const re = /(?:^|\n)[ \t]*@/g
  re.lastIndex = from
  const m = re.exec(text)
  return m ? m.index + m[0].length - 1 : text.length
}

/** Reads a whole `.bib` file (or pasted text). Never throws. */
export function parseBibtex(input: string): BibParse {
  const text = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const entries: BibEntry[] = []
  const problems: BibProblem[] = []
  const macros = new Map<string, string>()
  const lineOf = lineCounter(text)

  let i = 0
  while (i < text.length) {
    const at = text.indexOf('@', i)
    if (at < 0) break
    const sc = new Scanner(text, at + 1)
    sc.skipSpace()
    const type = sc.name().toLowerCase()
    sc.skipSpace()
    const open = sc.peek()
    if (type === '' || (open !== '{' && open !== '(')) {
      // An @ in ordinary text between entries (an address, a comment): not an entry.
      i = at + 1
      continue
    }
    const line = lineOf(at)
    if (SKIPPED.has(type)) {
      try {
        if (open === '{') sc.braced()
        else {
          const close = text.indexOf(')', sc.i)
          sc.i = close < 0 ? text.length : close + 1
        }
        i = sc.i
      } catch {
        i = nextEntryStart(text, at + 1)
      }
      continue
    }
    const close = open === '{' ? '}' : ')'
    sc.i++
    let key = ''
    try {
      if (type === 'string') {
        sc.skipSpace()
        const name = sc.name().toLowerCase()
        sc.skipSpace()
        if (name === '' || sc.peek() !== '=') throw new Unreadable('an @string needs a name, “=” and a value')
        sc.i++
        const value = readValue(sc, macros)
        sc.skipSpace()
        if (sc.peek() !== close) throw new Unreadable(`it does not end with “${close}”`)
        sc.i++
        macros.set(name, value)
        i = sc.i
        continue
      }
      sc.skipSpace()
      const keyStart = sc.i
      while (sc.i < text.length && !/[\s,]/.test(text[sc.i]!) && text[sc.i] !== close) sc.i++
      key = text.slice(keyStart, sc.i)
      const afterKey = sc.i
      sc.skipSpace()
      const looksLikeField = key.includes('=') || sc.peek() === '='
      sc.i = afterKey
      if (looksLikeField) {
        // No key at all: `@misc{title = …}`. Read the fields from the start.
        key = ''
        sc.i = keyStart
      }
      const fields = new Map<string, string>()
      for (;;) {
        sc.skipSpace()
        const ch = sc.peek()
        if (ch === close) {
          sc.i++
          break
        }
        if (ch === ',') {
          sc.i++
          continue
        }
        if (ch === '@' && atLineStart(text, sc.i)) {
          // The next entry starts: a brace is missing somewhere in this one, so what was read may be wrong.
          throw new Unreadable(`a brace is missing: the next entry starts before this one’s closing “${close}”`)
        }
        if (ch === '') throw new Unreadable(`the file ends before its closing “${close}”`)
        const name = sc.name().toLowerCase()
        if (name === '') throw new Unreadable(`there is a “${ch}” where a field name should be`)
        sc.skipSpace()
        if (sc.peek() !== '=') throw new Unreadable(`the field “${name}” has no “=” after it`)
        sc.i++
        const value = readValue(sc, macros)
        if (!fields.has(name)) fields.set(name, value)
      }
      entries.push(toEntry(type, key, line, fields))
      i = sc.i
    } catch (e) {
      if (!(e instanceof Unreadable)) throw e
      problems.push({ line, key, reason: e.message })
      i = nextEntryStart(text, at + 1)
    }
  }
  return { entries, problems }
}

/** "Line 12 (jerbi2021): a brace is opened and never closed." — for the import report. */
export function describeProblem(p: BibProblem): string {
  const where = p.key ? `Line ${p.line} (${p.key})` : `Line ${p.line}`
  return `${where}: ${p.reason}.`
}
