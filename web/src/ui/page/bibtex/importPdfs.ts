// Import BibTeX with files (decision 10): the PDFs an entry's `file` field names, read from the folder the person
// picked in the desktop app, stored on the server, and put on the entries' Sources in the same Undo step as the
// import (their ops join the entry's group, so they go in the same batch).
import { ApiError, DEFAULT_MAX_PDF_BYTES } from '../../../lib'
import type { PreparedPdf } from '../../pdf/attach'
import { attachOps } from '../../pdf/attach'
import { baseName, candidatePaths, pdfPathsOf } from './fileField'
import type { ImportPlan } from './importPlan'
import type { BibEntry } from './parse'

export type PdfOutcome = {
  /** File names, in the order attached. */
  attached: string[]
  notFound: string[]
  tooLarge: string[]
  failed: { name: string; why: string }[]
  /** Entries whose Source already had a PDF: theirs is kept. */
  kept: number
}

export const emptyOutcome = (): PdfOutcome => ({ attached: [], notFound: [], tooLarge: [], failed: [], kept: 0 })

/** How many entries name a PDF in their `file` field. */
export function entriesWithPdf(entries: readonly BibEntry[]): number {
  return entries.filter((e) => pdfPathsOf(e.file).length > 0).length
}

type Read = (path: string) => Promise<Uint8Array>
type Prepare = (bytes: Uint8Array, name: string) => Promise<PreparedPdf>

/** The first of an entry's PDFs that can be read from the folder, trying each path's shorter forms too. */
async function readFirst(paths: readonly string[], read: Read): Promise<{ bytes: Uint8Array; path: string } | null> {
  for (const p of paths) {
    for (const candidate of candidatePaths(p)) {
      try {
        return { bytes: await read(candidate), path: p }
      } catch {
        // Not there (or outside the folder): the next way of naming it.
      }
    }
  }
  return null
}

/**
 * Reads and stores the PDF of every entry that names one, one at a time. Resolves with the stored PDFs by entry
 * index and what became of each file; never rejects.
 */
export async function gatherPdfs(
  entries: readonly BibEntry[],
  read: Read,
  prepare: Prepare,
  onProgress: (done: number, total: number) => void = () => {},
  maxBytes = DEFAULT_MAX_PDF_BYTES,
): Promise<{ byEntry: Map<number, PreparedPdf>; outcome: PdfOutcome }> {
  const byEntry = new Map<number, PreparedPdf>()
  const outcome = emptyOutcome()
  const todo = entries.map((e, i) => ({ i, paths: pdfPathsOf(e.file) })).filter((t) => t.paths.length > 0)
  let done = 0
  onProgress(0, todo.length)
  for (const { i, paths } of todo) {
    const name = baseName(paths[0]!)
    const found = await readFirst(paths, read)
    if (!found) outcome.notFound.push(name)
    else if (found.bytes.byteLength > maxBytes) outcome.tooLarge.push(baseName(found.path))
    else {
      try {
        byEntry.set(i, await prepare(found.bytes, baseName(found.path)))
      } catch (e) {
        if (e instanceof ApiError && e.status === 413) outcome.tooLarge.push(baseName(found.path))
        else outcome.failed.push({ name: baseName(found.path), why: e instanceof Error ? e.message : 'it could not be sent' })
      }
    }
    onProgress(++done, todo.length)
  }
  return { byEntry, outcome }
}

/**
 * Puts the stored PDFs into the plan: each one's ops join its entry's group. A Source that already has a PDF keeps
 * it (counted in `kept`); a Source two entries share gets the first one's.
 */
export function addPdfOps(plan: ImportPlan, byEntry: ReadonlyMap<number, PreparedPdf>, outcome: PdfOutcome): void {
  const given = new Set<string>()
  for (const [i, pdf] of [...byEntry].sort((a, b) => a[0] - b[0])) {
    const entry = plan.entries[i]
    if (!entry) continue
    if (entry.pdf || given.has(entry.source)) {
      outcome.kept++
      continue
    }
    given.add(entry.source)
    plan.groups[entry.group]!.push(...attachOps(entry.source, pdf))
    outcome.attached.push(pdf.name)
  }
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function names(list: readonly string[], max = 5): string {
  const shown = list.slice(0, max).map((n) => `“${n}”`)
  const rest = list.length - shown.length
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ')
}

/** The report's lines about the PDFs. */
export function outcomeLines(o: PdfOutcome, folder: string): string[] {
  const lines: string[] = []
  if (o.attached.length) lines.push(`Attached ${count(o.attached.length, 'PDF')}.`)
  if (o.notFound.length) lines.push(`${count(o.notFound.length, 'PDF was', 'PDFs were')} not found in “${folder}”: ${names(o.notFound)}.`)
  if (o.tooLarge.length) lines.push(`${count(o.tooLarge.length, 'PDF is', 'PDFs are')} larger than the server takes and ${o.tooLarge.length === 1 ? 'was' : 'were'} left out: ${names(o.tooLarge)}.`)
  for (const f of o.failed.slice(0, 5)) lines.push(`“${f.name}” could not be attached: ${f.why.replace(/\.$/, '')}.`)
  if (o.failed.length > 5) lines.push(`${o.failed.length - 5} more could not be attached.`)
  if (o.kept) lines.push(`${count(o.kept, 'Source', 'Sources')} already had a PDF; ${o.kept === 1 ? 'it was' : 'theirs were'} kept.`)
  return lines
}
