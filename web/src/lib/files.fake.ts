// Test helper (not exported from index.ts): the M19 file endpoints of the fake server (testing.ts), as
// docs/specs/pdf-sources.md "Contracts" writes them. `FakeServer.pdf` is one of these.
import type { Entities } from './board-state'
import type { Member } from './types'

type Answer = { status: number; body: unknown }
const fail = (status: number, code: string, message = 'nope'): Answer => ({ status, body: { error: { code, message, detail: null } } })

/** Bytes that pass for a PDF where only the first bytes are looked at (the server's check); `label` makes them differ. */
export function tinyPdf(label = 'x'): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4\n% ${label}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`)
}

/**
 * The fake's content hash: 64 hex digits, the same for the same bytes (eight FNV-1a passes with different seeds).
 * Not SHA-256 — nothing in the web UI computes or checks the hash; it only carries what the server answered.
 */
export function contentHash(bytes: Uint8Array): string {
  let out = ''
  for (let seed = 0; seed < 8; seed++) {
    let h = (0x811c9dc5 ^ Math.imul(seed + 1, 0x9e3779b9)) >>> 0
    for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193) >>> 0
    h = Math.imul(h ^ bytes.length, 0x01000193) >>> 0
    out += h.toString(16).padStart(8, '0')
  }
  return out
}

async function bytesOf(body: unknown): Promise<Uint8Array | null> {
  if (body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    if (typeof body.arrayBuffer === 'function') return new Uint8Array(await body.arrayBuffer())
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
      reader.onerror = () => resolve(null)
      reader.readAsArrayBuffer(body)
    })
  }
  return null
}

const isPdf = (b: Uint8Array) => b.length >= 5 && String.fromCharCode(...b.subarray(0, 5)) === '%PDF-'

/** What the fake server needs to know to answer: who asks, and what main's present Board holds (the Guest rule). */
export type PdfContext = { actor: Member; main: Entities; readOnly: boolean }

export class FakePdfStore {
  /** Stored files by hash. */
  files = new Map<string, Uint8Array>()
  /** Stored text by hash (`PUT …/text`; first write wins). */
  texts = new Map<string, string[]>()
  /** Every `PUT …/text` body, in order (also the ones that were not kept). */
  textPuts: { hash: string; pages: string[] }[] = []
  /** What `POST /api/sources/fetch-pdf` downloads, by arXiv id. Anything else: arXiv "does not answer" (502). */
  arxiv: Record<string, Uint8Array> = {}
  /** The ids `fetch-pdf` was asked for, in order. */
  fetched: string[] = []
  /** The server's limit (`QOOP_MAX_PDF_MB`), in bytes. */
  maxBytes = 100 * 1024 * 1024
  /** One scripted failure for the next upload or fetch, e.g. `{ status: 413, code: 'too_large', message: '…' }`. */
  fail: { status: number; code: string; message: string } | null = null
  /** When set, uploads and fetches wait for it. */
  gate: Promise<void> | null = null
  /** How many search requests came in. */
  searches: string[] = []

  /** Stores bytes as the server would and returns the hash. */
  store(bytes: Uint8Array): string {
    const hash = contentHash(bytes)
    if (!this.files.has(hash)) this.files.set(hash, bytes.slice())
    return hash
  }

  private guestMaySee(main: Entities, hash: string): boolean {
    return Object.values(main).some((e) => e.kind === 'Source' && !e.deleted && typeof e.fields.pdf === 'object' && 'Text' in e.fields.pdf && e.fields.pdf.Text === hash)
  }

  /** Answers the routes under `/api/files/`, `/api/sources/fetch-pdf` and `/api/search/pdf`; null for any other path. */
  async route(path: string, init: RequestInit | undefined, body: unknown, ctx: PdfContext): Promise<Answer | Response | null> {
    const method = init?.method ?? 'GET'
    const guest = ctx.actor.role === 'guest'
    const write = method !== 'GET' && method !== 'HEAD'
    if (path === '/api/files/pdf' && method === 'PUT') {
      if (guest) return fail(403, 'forbidden')
      if (ctx.readOnly) return fail(403, 'moved', 'This Workspace was moved to a Team server; open it there to make changes.')
      if (this.gate) await this.gate
      if (this.fail) {
        const f = this.fail
        this.fail = null
        return fail(f.status, f.code, f.message)
      }
      const bytes = await bytesOf(body)
      if (!bytes) return fail(400, 'bad_request', 'No file came with the request.')
      if (bytes.length > this.maxBytes) return fail(413, 'too_large', `This PDF is larger than ${Math.round(this.maxBytes / 1024 / 1024)} MB, the most this server takes.`)
      if (!isPdf(bytes)) return fail(415, 'not_pdf', 'This file is not a PDF.')
      const hash = this.store(bytes)
      return { status: 200, body: { hash, size: bytes.length, pages: null } }
    }
    if (path === '/api/sources/fetch-pdf' && method === 'POST') {
      if (guest) return fail(403, 'forbidden')
      if (this.gate) await this.gate
      if (this.fail) {
        const f = this.fail
        this.fail = null
        return fail(f.status, f.code, f.message)
      }
      const id = typeof (body as { arxiv?: unknown })?.arxiv === 'string' ? (body as { arxiv: string }).arxiv : ''
      if (!id) return fail(400, 'bad_request', 'Give one arXiv id.')
      this.fetched.push(id)
      const bytes = this.arxiv[id]
      if (!bytes) return fail(502, 'fetch_failed', 'arXiv did not answer. Try again in a minute.')
      if (bytes.length > this.maxBytes) return fail(413, 'too_large', 'This PDF is larger than the server takes.')
      const hash = this.store(bytes)
      return { status: 200, body: { hash, size: bytes.length, pages: null } }
    }
    if (path.startsWith('/api/search/pdf')) {
      const q = new URLSearchParams(path.split('?')[1] ?? '').get('q') ?? ''
      this.searches.push(q)
      const needle = q.trim().toLowerCase()
      if (!needle) return { status: 200, body: [] }
      const hits: { hash: string; page: number; snippet: string }[] = []
      for (const [hash, pages] of this.texts) {
        if (guest && !this.guestMaySee(ctx.main, hash)) continue
        pages.forEach((text, i) => {
          const at = text.toLowerCase().indexOf(needle)
          if (at < 0) return
          const from = Math.max(0, at - 30)
          hits.push({ hash, page: i + 1, snippet: `${from > 0 ? '…' : ''}${text.slice(from, at + needle.length + 30).replace(/\s+/g, ' ')}` })
        })
      }
      return { status: 200, body: hits }
    }
    const m = /^\/api\/files\/pdf\/([0-9a-f]{64})(\/text)?$/.exec(path)
    if (!m) return path.startsWith('/api/files/') ? fail(404, 'not_found', 'no route') : null
    const hash = m[1]!
    if (m[2]) {
      if (method === 'PUT') {
        if (guest) return fail(403, 'forbidden')
        if (write && ctx.readOnly) return fail(403, 'moved', 'This Workspace was moved.')
        const pages = (body as { pages?: unknown })?.pages
        if (!Array.isArray(pages) || !pages.every((p) => typeof p === 'string')) return fail(400, 'bad_request')
        if (!this.files.has(hash)) return fail(404, 'not_found', 'No such PDF.')
        if (JSON.stringify(body).length > 20 * 1024 * 1024) return fail(413, 'too_large')
        this.textPuts.push({ hash, pages: pages as string[] })
        if (!this.texts.has(hash)) this.texts.set(hash, pages as string[])
        return { status: 204, body: undefined }
      }
      if (method === 'GET') {
        if (guest && !this.guestMaySee(ctx.main, hash)) return fail(403, 'forbidden')
        const text = this.texts.get(hash)
        return text ? { status: 200, body: { pages: text } } : fail(404, 'not_found', 'No text stored for this PDF.')
      }
      return fail(405, 'method_not_allowed')
    }
    if (method !== 'GET') return fail(405, 'method_not_allowed')
    if (guest && !this.guestMaySee(ctx.main, hash)) return fail(403, 'forbidden', 'This PDF is not on main.')
    const bytes = this.files.get(hash)
    if (!bytes) return fail(404, 'not_found', 'No such PDF.')
    const range = new Headers(init?.headers ?? {}).get('Range')
    const r = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null
    const from = r ? Number(r[1]) : 0
    const to = r && r[2] ? Math.min(Number(r[2]), bytes.length - 1) : bytes.length - 1
    const part = bytes.slice(from, to + 1)
    const headers = new Headers({
      'Content-Type': 'application/pdf',
      'Content-Length': String(part.length),
      'Accept-Ranges': 'bytes',
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
    })
    if (r) headers.set('Content-Range', `bytes ${from}-${to}/${bytes.length}`)
    const status = r ? 206 : 200
    return new Response(part.slice().buffer, { status, headers })
  }
}
