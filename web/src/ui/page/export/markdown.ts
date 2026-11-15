// A Page as one Markdown file. Pure.
//
// Title as `#`, the Card's summary, then the blocks in order: text as it is written (formulas are already
// `$…$` / `$$…$$` in it), a Run as a fenced code block followed by its captured output, a Visual as a line saying
// one is here, text pinned from an AI marked as such; the Sources as a numbered list at the end.
import { isLangId, runLang } from '../../../lib'
import type { BlockVM, RunResult } from '../../../lib'
import { figureSrc } from '../runs/format'
import { sourceLink } from '../sourceId'

export type MarkdownSource = { title: string; authors: string; year: string; doi: string; url: string; note: string }

export type MarkdownPage = {
  title: string
  summary: string
  blocks: readonly BlockVM[]
  sources: readonly MarkdownSource[]
  /** A Member's name for "pinned by" / "last run by"; whatever stands in for someone unknown. */
  nameOf: (memberId: string) => string
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number) => String(n).padStart(2, '0')

/** "12 Nov 2026" — with the year always: a file outlives this year. */
export function longDate(ms: number): string {
  const d = new Date(ms)
  return Number.isFinite(d.getTime()) ? `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : ''
}

function dateTime(ms: number): string {
  const d = new Date(ms)
  return Number.isFinite(d.getTime()) ? `${longDate(ms)}, ${pad(d.getHours())}:${pad(d.getMinutes())}` : ''
}

/** A fenced code block whose fence is longer than any run of backticks inside. */
export function fenced(text: string, info = ''): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  const body = text.replace(/\r\n?/g, '\n').replace(/\n$/, '')
  return `${fence}${info}\n${body}\n${fence}`
}

/** Text that must read as plain words in Markdown (a title, a name): the characters that would start markup escaped. */
export function plain(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/([\\`*_[\]<>#|~$])/g, '\\$1')
}

function quoted(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n')
}

function runOutput(result: RunResult, name: string, nameOf: MarkdownPage['nameOf']): string {
  const parts: string[] = []
  const ended = result.exit === null || result.stopped ? 'stopped' : result.exit !== 0 ? `exit ${result.exit}` : ''
  const record = [`Last run by ${plain(nameOf(result.by))}`, dateTime(result.at)].filter(Boolean).join(', ')
  parts.push(`*Output — ${record}${ended ? ` · ${ended}` : ''}:*`)
  if (result.output !== '') parts.push(fenced(result.output, 'text'))
  if (result.output_truncated) parts.push('*Part of the output was left out.*')
  result.figures.forEach((f, i) => {
    const src = figureSrc(f.png)
    if (src) parts.push(`![Figure ${i + 1} of Run ${plain(name)}](${src})`)
  })
  if (result.output === '' && result.figures.length === 0) parts.push('*The Run printed nothing.*')
  return parts.join('\n\n')
}

function blockMarkdown(block: BlockVM, nameOf: MarkdownPage['nameOf']): string {
  if (block.type === 'visual') {
    const title = block.title.trim() || 'Untitled'
    return `*Visual: ${plain(title)}. It is interactive — open this Page in Infall to use it.*`
  }
  if (block.type === 'run') {
    const name = block.title.trim() || 'Run'
    // The fence is tagged with the Run's language id (M19b; portability.md), Python when it names none.
    const lang = runLang(block)
    const code = fenced(block.text, isLangId(lang) ? lang : '')
    const result = block.run?.result ?? null
    const out = block.run?.broken
      ? '*This result cannot be shown.*'
      : result
        ? runOutput(result, name, nameOf)
        : '*Not executed yet.*'
    return `**Run: ${plain(name)}**\n\n${code}\n\n${out}`
  }
  const text = block.text.replace(/\r\n?/g, '\n').trim()
  if (!block.ai) return text
  const ai = block.ai
  const review = ai.reviewedBy ? `reviewed by ${plain(nameOf(ai.reviewedBy))}` : 'not reviewed by a Member'
  const head = `**AI-generated** · ${plain(ai.model || 'unknown model')} · pinned by ${plain(nameOf(ai.pinnedBy))}, ${longDate(ai.pinnedAt)} · ${review}`
  return quoted(text === '' ? head : `${head}\n\n${text}`)
}

/** One line per Source: "Authors (Year). *Title*. doi:… — note". */
export function sourceLine(s: MarkdownSource): string {
  const parts: string[] = []
  const who = s.authors.trim()
  const year = s.year.trim()
  if (who) parts.push(`${plain(who)}${year ? ` (${plain(year)})` : ''}.`)
  else if (year) parts.push(`(${plain(year)}).`)
  parts.push(`*${plain(s.title) || 'Untitled Source'}*.`)
  const link = sourceLink(s)
  if (link) parts.push(link.text === link.href ? `<${link.href}>` : `[${plain(link.text)}](${link.href.replace(/[()]/g, encodeURIComponent)})`)
  if (s.note.trim()) parts.push(`— ${plain(s.note)}`)
  return parts.join(' ')
}

/** The whole Page. Ends with one line break. */
export function pageMarkdown(page: MarkdownPage): string {
  const parts: string[] = [`# ${plain(page.title) || 'Untitled'}`]
  if (page.summary.trim()) parts.push(page.summary.replace(/\r\n?/g, '\n').trim())
  for (const b of page.blocks) {
    const md = blockMarkdown(b, page.nameOf)
    if (md !== '') parts.push(md)
  }
  if (page.sources.length > 0) {
    parts.push('## Sources')
    parts.push(page.sources.map((s, i) => `${i + 1}. ${sourceLine(s)}`).join('\n'))
  }
  return `${parts.join('\n\n')}\n`
}
