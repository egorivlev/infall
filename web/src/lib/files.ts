// M19 Part 1 (docs/specs/pdf-sources.md): a PDF on a Source. The bytes live outside the Change log, stored once by
// their SHA-256; the Source only carries `pdf` (the hash), `pdf_name`, `pdf_size` and `pdf_pages` — ordinary fields,
// so which PDF a Source has is in History, per Branch, merged and undone like a title.
//
// This module talks to the server's file endpoints and builds the ops that set those fields. Reading and rendering
// a PDF is the UI's own (ui/pdf, with pdf.js); extracting its text is too, and the text is handed back here.
import { ApiError, MOVED_SENTENCE, errorFromBody, networkError, request, requestBytes } from './http'
import type { UploadProgress } from './http'
import { sessionStore } from './session-store'
import { workspaceStore } from './workspace'
import type { Op, SourceVM, Value } from './types'

/** What the server keeps of one PDF: its hash, its size in bytes, and its page count when known. */
export type StoredPdf = { hash: string; size: number; pages: number | null }

/** One place in a PDF's stored text that matches a search (`GET /api/search/pdf?q=`); `page` counts from 1. */
export type PdfHit = { hash: string; page: number; snippet: string }

/** What a Source's PDF fields say; null when it has none. */
export type SourcePdf = { hash: string; name: string; size: number; pages: number | null }

/** The server takes at most this much text per PDF (`PUT …/text`). */
export const MAX_PDF_TEXT_BYTES = 20 * 1024 * 1024
/** The server's default limit per file (`INFALL_MAX_PDF_MB`); the server's own answer (413) is what counts. */
export const DEFAULT_MAX_PDF_BYTES = 100 * 1024 * 1024

const HASH = /^[0-9a-f]{64}$/

function self() {
  const s = sessionStore.getState()
  return s.status === 'signed_in' ? s.member : null
}

/** A write: a Member, in a Workspace that was not moved away. */
function writer(what: string): void {
  const me = self()
  if (!me || me.role === 'guest') throw new ApiError(403, 'forbidden', `Guests cannot ${what}.`)
  if (workspaceStore.getState().readOnly) throw new ApiError(403, 'moved', MOVED_SENTENCE)
}

function checkHash(hash: string): string {
  if (!HASH.test(hash)) throw new ApiError(400, 'bad_request', 'That is not the hash of a stored PDF.')
  return hash
}

/** Whether these first bytes are a PDF's (`%PDF-`), the way the server checks: by content, not by name. */
export function isPdfBytes(head: Uint8Array): boolean {
  // A PDF may have up to 1 KiB of junk before its header; readers accept that, and so does this.
  const limit = Math.min(head.length - 5, 1024)
  for (let i = 0; i <= limit; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) return true
  }
  return false
}

// Bytes from another realm (a webview's bridge, jsdom) are not `instanceof` this realm's Uint8Array.
const isBytes = (v: unknown): v is Uint8Array => ArrayBuffer.isView(v)

async function headOf(body: Blob | Uint8Array): Promise<Uint8Array> {
  if (isBytes(body)) return new Uint8Array(body.buffer, body.byteOffset, Math.min(body.byteLength, 1029))
  const part = body.slice(0, 1029)
  if (typeof part.arrayBuffer === 'function') return new Uint8Array(await part.arrayBuffer())
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'))
    reader.readAsArrayBuffer(part)
  })
}

function readStored(json: unknown): StoredPdf {
  const o = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {}
  const hash = typeof o.hash === 'string' ? o.hash.toLowerCase() : ''
  if (!HASH.test(hash)) throw new ApiError(200, 'internal', 'The server did not say where it stored the PDF.')
  const size = typeof o.size === 'number' && Number.isFinite(o.size) && o.size >= 0 ? Math.round(o.size) : 0
  const pages = typeof o.pages === 'number' && Number.isInteger(o.pages) && o.pages > 0 ? o.pages : null
  return { hash, size, pages }
}

function parse(raw: string): unknown {
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * `PUT /api/files/pdf`, the body the PDF as `application/pdf`. XMLHttpRequest where the page has it (upload
 * progress), else fetch (progress only at the end). An abort rejects with ApiError(0, 'aborted').
 */
function put(body: Blob, total: number, onProgress?: UploadProgress, signal?: AbortSignal): Promise<StoredPdf> {
  const path = '/api/files/pdf'
  const finish = (status: number, raw: string): StoredPdf => {
    if (status < 200 || status >= 300) throw errorFromBody(status, raw)
    const json = parse(raw)
    if (json === undefined) throw new ApiError(status, 'internal', 'The server sent an unreadable response.')
    return readStored(json)
  }
  const aborted = () => new ApiError(0, 'aborted', 'The upload was stopped.')
  if (typeof XMLHttpRequest === 'undefined') {
    return fetch(path, {
      method: 'PUT',
      headers: { Accept: 'application/json', 'Content-Type': 'application/pdf', 'X-Infall-Request': '1' },
      body,
      credentials: 'same-origin',
      signal,
    }).then(
      async (res) => {
        const raw = await res.text()
        onProgress?.(total, total)
        return finish(res.status, raw)
      },
      () => {
        throw signal?.aborted ? aborted() : networkError()
      },
    )
  }
  return new Promise<StoredPdf>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', path)
    xhr.withCredentials = true
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.setRequestHeader('Content-Type', 'application/pdf')
    xhr.setRequestHeader('X-Infall-Request', '1')
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (e: ProgressEvent) => onProgress(e.loaded, e.lengthComputable ? e.total : total)
    }
    xhr.onload = () => {
      try {
        onProgress?.(total, total)
        resolve(finish(xhr.status, typeof xhr.responseText === 'string' ? xhr.responseText : ''))
      } catch (e) {
        reject(e)
      }
    }
    xhr.onerror = () => reject(networkError())
    xhr.onabort = () => reject(aborted())
    if (signal) {
      if (signal.aborted) return reject(aborted())
      signal.addEventListener('abort', () => xhr.abort(), { once: true })
    }
    xhr.send(body)
  })
}

/** The text of every page, cut so that the JSON stays under the server's limit (rare: a 20 MB PDF of plain text). */
export function fitText(pages: readonly string[], maxBytes = MAX_PDF_TEXT_BYTES): string[] {
  const size = (list: readonly string[]) => new Blob([JSON.stringify({ pages: list })]).size
  let out = pages.map((p) => (typeof p === 'string' ? p : ''))
  if (size(out) <= maxBytes) return out
  // Share the room evenly among the pages, then let each keep what fits.
  let per = Math.floor(maxBytes / Math.max(1, out.length) / 3)
  for (let i = 0; i < 8; i++) {
    const cut = out.map((p) => (p.length > per ? p.slice(0, per) : p))
    if (size(cut) <= maxBytes) return cut
    per = Math.floor(per / 2)
    out = cut
  }
  return out.map(() => '')
}

export const pdfFiles = {
  /**
   * Stores a PDF (`PUT /api/files/pdf`) and resolves with its hash, size and (usually null) page count. Idempotent
   * by content. Rejects locally, without a request: 403 for a Guest or a moved copy, 415 `not_a_pdf` when the first
   * bytes are not a PDF's, 400 for an empty file. The server's refusals come through as they are (413 over the
   * limit, 415 not a PDF), their `message` the server's sentence.
   */
  async upload(file: Blob | Uint8Array, options: { onProgress?: UploadProgress; signal?: AbortSignal } = {}): Promise<StoredPdf> {
    writer('attach PDFs')
    const total = isBytes(file) ? file.byteLength : file.size
    if (total === 0) throw new ApiError(400, 'bad_request', 'This file is empty.')
    let head: Uint8Array
    try {
      head = await headOf(file)
    } catch {
      throw new ApiError(400, 'unreadable', 'The file could not be read.')
    }
    if (!isPdfBytes(head)) throw new ApiError(415, 'not_a_pdf', 'This file is not a PDF.')
    const body = isBytes(file) ? new Blob([file as BlobPart], { type: 'application/pdf' }) : file
    return put(body, total, options.onProgress, options.signal)
  },

  /** Where the stored PDF is read from (`GET /api/files/pdf/{hash}`, with Range); a same-origin path for pdf.js. */
  url(hash: string): string {
    return `/api/files/pdf/${checkHash(hash)}`
  },

  /** The whole file, for Save a copy / Open in the system viewer. */
  async bytes(hash: string): Promise<Uint8Array> {
    return (await requestBytes(pdfFiles.url(hash))).bytes
  },

  /**
   * `PUT /api/files/pdf/{hash}/text` with `{ pages }` (one string per page, page 1 first). The server keeps the
   * first text it gets for a hash; a second write is harmless. Members only (403 locally for a Guest).
   */
  async putText(hash: string, pages: readonly string[]): Promise<void> {
    writer('store the text of a PDF')
    await request('PUT', `${pdfFiles.url(hash)}/text`, { pages: fitText(pages) })
  },

  /** `GET …/text`: the stored text per page, or null when none was stored yet (404). */
  async getText(hash: string): Promise<string[] | null> {
    try {
      const answer = await request<{ pages?: unknown }>('GET', `${pdfFiles.url(hash)}/text`)
      return Array.isArray(answer.pages) ? answer.pages.map((p) => (typeof p === 'string' ? p : '')) : null
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null
      throw e
    }
  },

  /**
   * `POST /api/sources/fetch-pdf {arxiv}`: the server downloads `https://arxiv.org/pdf/<id>`, stores it and answers
   * as an upload does. Only the id is sent; only on the person's button. 502 with the server's sentence when arXiv
   * does not answer; 403 locally for a Guest; 400 locally for something that is not an arXiv id.
   */
  async fetchArxiv(id: string): Promise<StoredPdf> {
    writer('fetch PDFs')
    const clean = id.trim()
    if (!/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/.test(clean)) {
      throw new ApiError(400, 'bad_request', 'That is not an arXiv id.')
    }
    return readStored(await request('POST', '/api/sources/fetch-pdf', { arxiv: clean }))
  },

  /**
   * `GET /api/search/pdf?q=`: places in stored PDF text that match. Fewer than 2 characters asks nothing and gives [].
   * Items the server sends that cannot be read are dropped; `page` counts from 1.
   */
  async search(query: string): Promise<PdfHit[]> {
    const q = query.trim()
    if ([...q].length < 2) return []
    const answer = await request<unknown>('GET', `/api/search/pdf?q=${encodeURIComponent(q)}`)
    const list = Array.isArray(answer) ? answer : Array.isArray((answer as { hits?: unknown }).hits) ? (answer as { hits: unknown[] }).hits : []
    const out: PdfHit[] = []
    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue
      const { hash, page, snippet } = item as Record<string, unknown>
      if (typeof hash !== 'string' || !HASH.test(hash.toLowerCase())) continue
      if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) continue
      out.push({ hash: hash.toLowerCase(), page, snippet: typeof snippet === 'string' ? snippet : '' })
    }
    return out
  },
}

const txt = (s: string): Value => ({ Text: s })
const set = (entity: string, field: string, value: Value): Op => ({ Set: { entity, field, value } })

/** A file name a Source keeps: no path, no control characters, at most 255 characters. */
export function pdfName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const clean = [...base]
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
    .join('')
    .trim()
    .slice(0, 255)
  return clean || 'document.pdf'
}

export const pdfOps = {
  /** The four Sets that give `source` this PDF (attach or replace). `pages` null leaves the page count unset. */
  attach(source: string, pdf: { hash: string; name: string; size: number; pages: number | null }): Op[] {
    const hash = checkHash(pdf.hash)
    if (!Number.isFinite(pdf.size) || pdf.size < 0) throw new RangeError('A PDF size must be a finite number.')
    return [
      set(source, 'pdf', txt(hash)),
      set(source, 'pdf_name', txt(pdfName(pdf.name))),
      set(source, 'pdf_size', { Float: Math.round(pdf.size) }),
      set(source, 'pdf_pages', pdf.pages !== null && Number.isInteger(pdf.pages) && pdf.pages > 0 ? { Float: pdf.pages } : 'Null'),
    ]
  },
  /** The four Sets that take the PDF off `source`. The stored file stays (decision 3). */
  remove(source: string): Op[] {
    return ['pdf', 'pdf_name', 'pdf_size', 'pdf_pages'].map((f) => set(source, f, 'Null'))
  },
}

/** A Source's PDF, read from its view model. */
export function sourcePdf(source: Pick<SourceVM, 'pdf' | 'pdfName' | 'pdfSize' | 'pdfPages'>): SourcePdf | null {
  if (!source.pdf) return null
  return { hash: source.pdf, name: source.pdfName || 'document.pdf', size: source.pdfSize ?? 0, pages: source.pdfPages ?? null }
}
