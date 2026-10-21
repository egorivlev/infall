// Sources as BibTeX, for LaTeX, Zotero and the rest. Pure.
//
// `@article` when the Source has a DOI, else `@misc`; keys `firstauthorYEARword` made unique with a
// letter (`jerbi2021parametrized`, `jerbi2021parametrizeda`); text escaped so that BibTeX and LaTeX
// read back exactly what was written. Letters beyond ASCII stay as they are (the file is UTF-8, which
// biber and bibtex8 read; classic BibTeX keeps them as bytes).

export type BibSource = { title: string; authors: string; year: string; doi: string; url: string; note: string }

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'on',
  'of',
  'in',
  'for',
  'and',
  'to',
  'with',
  'from',
  'by',
  'at',
  'is',
  'are',
  'towards',
  'toward',
  'via',
  'der',
  'die',
  'das',
  'le',
  'la',
  'les',
  'un',
  'une',
])

/** Plain ASCII letters and digits, lower-case: "Müller-Šťastný" → "mullerstastny". */
function keyPart(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[øØ]/g, 'o')
    .replace(/[æÆ]/g, 'ae')
    .replace(/[łŁ]/g, 'l')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/** The people in a Source's Authors field: "S. Jerbi, V. Dunjko", "Jerbi, S.; Dunjko, V.", "A and B". */
export function splitAuthors(authors: string): { names: string[]; others: boolean } {
  let text = authors.trim()
  let others = false
  const etAl = /,?\s*(?:et\.?\s*al\.?|and others)\s*$/i
  if (etAl.test(text)) {
    others = true
    text = text.replace(etAl, '')
  }
  const sep = text.includes(';') ? /\s*;\s*/ : /\s+and\s+/i.test(text) ? /\s*,?\s+and\s+|\s*,\s*/i : /\s*,\s*/
  const names = text
    .split(sep)
    .map((n) => n.trim())
    .filter((n) => n !== '')
  return { names, others }
}

/**
 * One person as BibTeX wants them: "Family, Given". The Authors field holds "Given Family" (what Look up and the
 * importer write); lower-case particles stay with the family name ("John von Neumann" → "von Neumann, John").
 * A name already written "Family, Given", or a single word, is kept as it is.
 */
export function bibtexName(name: string): string {
  const n = name.trim()
  if (n.includes(',')) return n
  const words = n.split(/\s+/)
  if (words.length < 2) return n
  let k = words.length - 1
  while (k > 1 && /^[a-z]/.test(words[k - 1]!)) k--
  return `${words.slice(k).join(' ')}, ${words.slice(0, k).join(' ')}`
}

/** The family name of one person as written in the Authors field ("S. Jerbi" → "Jerbi", "Jerbi, S." → "Jerbi"). */
function familyName(name: string): string {
  return bibtexName(name).split(',')[0]!.trim()
}

/** `firstauthorYEARword`, without making it unique. */
export function baseKey(source: Pick<BibSource, 'authors' | 'title' | 'year'>): string {
  const first = splitAuthors(source.authors).names[0]
  const author = first ? keyPart(familyName(first)) : ''
  const year = /\d{4}/.exec(source.year)?.[0] ?? ''
  const word =
    source.title
      .split(/[\s\-–—/:]+/)
      .map(keyPart)
      .find((w) => w !== '' && !STOP_WORDS.has(w)) ?? ''
  const key = `${author || 'source'}${year}${word}`
  return key
}

/** a, b, …, z, aa, ab, … */
function suffix(n: number): string {
  let s = ''
  for (let k = n; k >= 0; k = Math.floor(k / 26) - 1) s = String.fromCharCode(97 + (k % 26)) + s
  return s
}

const SPECIAL: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
}

/**
 * Text for a BibTeX value in braces. Special characters are escaped; braces too, as `\{` and `\}` where
 * they pair up (BibTeX counts every brace, so the pairs keep the value balanced) and as
 * `\textbraceleft{}` / `\textbraceright{}` where they do not.
 */
export function escapeText(text: string): string {
  // Math (`$\mathrm{SU}(2)$`) is kept as written when its braces pair up: LaTeX reads it, and so does the importer.
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(\$[^$]+\$)/)
    .map((part, i) => (i % 2 === 1 && balanced(part) ? part : escapePlain(part)))
    .join('')
}

function balanced(text: string): boolean {
  let depth = 0
  for (const ch of text) {
    if (ch === '{') depth++
    else if (ch === '}' && --depth < 0) return false
  }
  return depth === 0
}

function escapePlain(text: string): string {
  const chars = [...text]
  const paired = new Set<number>()
  const open: number[] = []
  chars.forEach((ch, i) => {
    if (ch === '{') open.push(i)
    else if (ch === '}' && open.length > 0) {
      paired.add(open.pop()!)
      paired.add(i)
    }
  })
  return chars
    .map((ch, i) => {
      if (ch === '{') return paired.has(i) ? '\\{' : '\\textbraceleft{}'
      if (ch === '}') return paired.has(i) ? '\\}' : '\\textbraceright{}'
      return SPECIAL[ch] ?? ch
    })
    .join('')
}

/** An address or DOI in braces: written as it is, except that a brace (never balanced on purpose) is percent-encoded. */
function escapeVerbatim(text: string): string {
  return text.trim().replace(/\{/g, '%7B').replace(/\}/g, '%7D').replace(/\s/g, '%20')
}

const ARXIV = /^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/(.+?)(?:\.pdf)?\/?$/i

/** One `.bib` text for all `sources`, in the order given; '' for none. */
export function toBibtex(sources: readonly BibSource[]): string {
  const used = new Set<string>()
  const out: string[] = []
  for (const s of sources) {
    const base = baseKey(s)
    let key = base
    for (let n = 0; used.has(key); n++) key = `${base}${suffix(n)}`
    used.add(key)

    const doi = s.doi.trim()
    const url = s.url.trim()
    const fields: [string, string][] = []
    if (s.title.trim()) fields.push(['title', escapeText(s.title)])
    const { names, others } = splitAuthors(s.authors)
    if (names.length > 0 || others) fields.push(['author', [...names.map((n) => escapeText(bibtexName(n))), ...(others ? ['others'] : [])].join(' and ')])
    if (s.year.trim()) fields.push(['year', escapeText(s.year)])
    if (doi) fields.push(['doi', escapeVerbatim(doi)])
    if (url) fields.push(['url', escapeVerbatim(url)])
    const arxiv = ARXIV.exec(url)
    if (arxiv) {
      fields.push(['eprint', escapeVerbatim(arxiv[1]!)])
      fields.push(['archiveprefix', 'arXiv'])
    }
    if (s.note.trim()) fields.push(['note', escapeText(s.note)])

    const width = Math.max(0, ...fields.map(([name]) => name.length))
    const body = fields.map(([name, value]) => `  ${name.padEnd(width)} = {${value}}`).join(',\n')
    out.push(`@${doi ? 'article' : 'misc'}{${key}${body ? `,\n${body}` : ''}\n}`)
  }
  return out.length ? `${out.join('\n\n')}\n` : ''
}
