// The text of a PDF, for Find in the reader and for search (decision 8): extracted once in the browser — when the
// PDF is attached, or the first time it is opened — and sent to the server, which keeps the first text it gets.
import { pdfFiles } from '../../lib'
import { extractText, openPdf } from './engine'
import type { PdfDoc } from './engine'

const known = new Map<string, string[]>()
const asking = new Map<string, Promise<string[] | null>>()
/** Hashes whose text this window already sent (or found on the server). */
const stored = new Set<string>()

async function send(hash: string, pages: string[]): Promise<void> {
  if (stored.has(hash)) return
  stored.add(hash)
  try {
    await pdfFiles.putText(hash, pages)
  } catch {
    // Search simply does not find this PDF yet; the next open tries again.
    stored.delete(hash)
  }
}

/**
 * The text of every page of `hash`: what this window knows, else the server's, else read from `doc` (and then
 * sent when `canStore`: a Member in a Workspace that can be written). Null when there is none and no `doc`.
 */
export function pdfText(hash: string, doc: PdfDoc | null, canStore: boolean): Promise<string[] | null> {
  const have = known.get(hash)
  if (have) return Promise.resolve(have)
  const pending = asking.get(hash)
  if (pending) return pending
  const p = (async () => {
    let pages: string[] | null = null
    try {
      pages = await pdfFiles.getText(hash)
      if (pages) stored.add(hash)
    } catch {
      pages = null
    }
    if (!pages && doc) {
      pages = await extractText(doc)
      if (pages && canStore) void send(hash, pages)
    }
    if (pages) known.set(hash, pages)
    return pages
  })().finally(() => asking.delete(hash))
  asking.set(hash, p)
  return p
}

let queue: Promise<void> = Promise.resolve()

/**
 * After attaching: reads the text from the bytes just uploaded and sends it, in the background and one PDF at a
 * time (an import of thirty PDFs does not read thirty at once). Nothing to wait for; a failure is silent.
 */
export function storeTextOf(hash: string, bytes: Uint8Array): void {
  if (stored.has(hash) || known.has(hash)) return
  queue = queue.then(async () => {
    if (stored.has(hash)) return
    try {
      const { doc } = await openPdf({ data: bytes })
      try {
        const pages = await extractText(doc)
        if (pages) {
          known.set(hash, pages)
          await send(hash, pages)
        }
      } finally {
        doc.destroy()
      }
    } catch {
      // Not readable here; the reader tries again when it is opened.
    }
  })
}

/** For tests. */
export function forgetTexts(): void {
  known.clear()
  asking.clear()
  stored.clear()
  queue = Promise.resolve()
}
