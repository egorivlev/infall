// Getting a PDF onto a Source: store the file (the server checks it), count its pages here, and build the ops that
// set the Source's fields — one Undo step, named as decision 2's contract says ("Attach a PDF to <title>").
import { ApiError, pdfFiles, pdfName, pdfOps } from '../../lib'
import type { Op, StoredPdf, UploadProgress } from '../../lib'
import { countPages } from './engine'
import { storeTextOf } from './text'

/** A PDF stored on the server and ready to be put on a Source. */
export type PreparedPdf = { hash: string; name: string; size: number; pages: number | null; bytes: Uint8Array }

async function bytesOf(file: Blob): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer())
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'))
    reader.readAsArrayBuffer(file)
  })
}

/** Uploads `file` and counts its pages. Rejects with the lib's ApiError (the server's sentence in `message`). */
export async function preparePdf(file: Blob | Uint8Array, name: string, options: { onProgress?: UploadProgress; signal?: AbortSignal } = {}): Promise<PreparedPdf> {
  const bytes = ArrayBuffer.isView(file) ? (file as Uint8Array) : await bytesOf(file as Blob)
  const stored = await pdfFiles.upload(bytes, options)
  return readyFrom(stored, name, bytes)
}

/** A PDF the server already stored (fetched from arXiv): its page count, read here from its bytes. */
export async function readyFrom(stored: StoredPdf, name: string, bytes?: Uint8Array): Promise<PreparedPdf> {
  const data = bytes ?? (await pdfFiles.bytes(stored.hash))
  const pages = stored.pages ?? (await countPages(data))
  return { hash: stored.hash, name: pdfName(name), size: stored.size || data.byteLength, pages, bytes: data }
}

/** The Sets that put `pdf` on `sourceId`; also starts sending the PDF's text for search (decision 8). */
export function attachOps(sourceId: string, pdf: PreparedPdf): Op[] {
  storeTextOf(pdf.hash, pdf.bytes)
  return pdfOps.attach(sourceId, pdf)
}

const titled = (title: string) => title.trim() || 'Untitled Source'

/** The names of the three steps in Undo. */
export const pdfStep = {
  attach: (title: string) => `Attach a PDF to ${titled(title)}`,
  replace: (title: string) => `Replace the PDF of ${titled(title)}`,
  remove: (title: string) => `Remove the PDF from ${titled(title)}`,
}

const OFFLINE = 'Infall’s server cannot be reached right now, so the PDF was not attached. Try again once the connection is back.'

/** What to say when a PDF could not be attached: the server's own sentence when it sent one. */
export function attachFailure(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'aborted') return 'Stopped. Nothing was attached.'
    if (e.status === 0) return OFFLINE
    const own = e.message && !/^Request failed \(\d+\)\.$/.test(e.message) ? e.message : ''
    if (own) return own
    if (e.status === 413) return 'This PDF is larger than this server takes.'
    if (e.status === 415) return 'This file is not a PDF.'
    if (e.status === 403) return 'Only Members can attach PDFs.'
  }
  return 'The PDF could not be attached. Try again.'
}

/** "820 KB", "1.4 MB", "12 bytes". */
export function sizeText(bytes: number): string {
  if (!(bytes >= 0)) return ''
  if (bytes < 1000) return `${Math.round(bytes)} ${bytes === 1 ? 'byte' : 'bytes'}`
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`
  const mb = bytes / 1_000_000
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

/** "1 page", "12 pages"; '' when unknown. */
export function pagesText(pages: number | null | undefined): string {
  return pages ? `${pages} ${pages === 1 ? 'page' : 'pages'}` : ''
}

/** "12 pages · 1.4 MB" */
export function pdfFacts(pdf: { size: number; pages: number | null }): string {
  return [pagesText(pdf.pages), sizeText(pdf.size)].filter(Boolean).join(' · ')
}

/** Whether a picked or dropped file looks like a PDF by its name or type (the bytes are checked when it is sent). */
export function looksLikePdf(file: { name: string; type: string }): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
}
