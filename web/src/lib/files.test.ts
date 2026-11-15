// M19 Part 1: the file endpoints against the fake server, the PDF fields on a Source, and the ops that set them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyOps, toPageIndex } from './board-state'
import type { Entities } from './board-state'
import { fitText, isPdfBytes, pdfFiles, pdfName, pdfOps, sourcePdf } from './files'
import { ApiError } from './http'
import { ops } from './ops'
import { sessionStore } from './session-store'
import { FakeServer, GUEST, ME, contentHash, tinyPdf } from './testing'
import { workspaceStore } from './workspace'

let server: FakeServer
const H = 'a'.repeat(64)

beforeEach(() => {
  server = new FakeServer()
  vi.stubGlobal('fetch', server.fetch)
  vi.stubGlobal('XMLHttpRequest', undefined)
  sessionStore.setState({ status: 'signed_in', member: ME }, true)
})
afterEach(() => {
  sessionStore.setState({ status: 'signed_out' }, true)
  workspaceStore.setState({ readOnly: false })
  vi.unstubAllGlobals()
})

const rejection = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e as ApiError
  }
  throw new Error('expected a rejection')
}

describe('upload', () => {
  it('PUTs the PDF as application/pdf and answers hash, size and pages', async () => {
    const bytes = tinyPdf('one')
    const stored = await pdfFiles.upload(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
    expect(stored).toEqual({ hash: contentHash(bytes), size: bytes.length, pages: null })
    const put = server.requests.find((r) => r.method === 'PUT' && r.path === '/api/files/pdf')
    expect(put).toBeTruthy()
    expect(server.pdf.files.has(stored.hash)).toBe(true)
  })

  it('reports upload progress through XMLHttpRequest, ending with the whole size', async () => {
    vi.stubGlobal('XMLHttpRequest', server.xhr())
    const bytes = tinyPdf('progress')
    const seen: [number, number][] = []
    await pdfFiles.upload(bytes, { onProgress: (sent, total) => seen.push([sent, total]) })
    expect(seen.length).toBeGreaterThanOrEqual(4)
    expect(seen[seen.length - 1]).toEqual([bytes.length, bytes.length])
    expect(server.requests.some((r) => r.method === 'PUT' && r.path === '/api/files/pdf')).toBe(true)
  })

  it('is idempotent by content', async () => {
    const a = await pdfFiles.upload(tinyPdf('same'))
    const b = await pdfFiles.upload(tinyPdf('same'))
    expect(a.hash).toBe(b.hash)
    expect(server.pdf.files.size).toBe(1)
  })

  it('refuses a file that is not a PDF by its first bytes, without a request', async () => {
    const e = await rejection(pdfFiles.upload(new Blob(['hello, not a pdf'])))
    expect(e).toMatchObject({ status: 415, code: 'not_pdf' })
    expect(server.requests.filter((r) => r.path === '/api/files/pdf')).toHaveLength(0)
  })

  it('passes the server’s refusals on with their sentence (413, 415)', async () => {
    server.pdf.maxBytes = 10
    const e = await rejection(pdfFiles.upload(tinyPdf('big')))
    expect(e).toMatchObject({ status: 413, code: 'too_large' })
    expect(e.message).toMatch(/larger than/)
    server.pdf.fail = { status: 415, code: 'not_pdf', message: 'The server says this is not a PDF.' }
    server.pdf.maxBytes = 1e9
    expect(await rejection(pdfFiles.upload(tinyPdf('x')))).toMatchObject({ status: 415, message: 'The server says this is not a PDF.' })
  })

  it('refuses locally for a Guest and in a moved copy', async () => {
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
    expect(await rejection(pdfFiles.upload(tinyPdf()))).toMatchObject({ status: 403, code: 'forbidden' })
    sessionStore.setState({ status: 'signed_in', member: ME }, true)
    workspaceStore.setState({ readOnly: true })
    expect(await rejection(pdfFiles.upload(tinyPdf()))).toMatchObject({ status: 403, code: 'moved' })
    expect(server.requests).toHaveLength(0)
  })

  it('an empty file is refused locally', async () => {
    expect(await rejection(pdfFiles.upload(new Uint8Array()))).toMatchObject({ status: 400 })
  })

  it('a network failure is status 0', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline')
    })
    expect(await rejection(pdfFiles.upload(tinyPdf()))).toMatchObject({ status: 0, code: 'network' })
  })
})

describe('reading a stored PDF', () => {
  it('url() is the same-origin path; bytes() reads the whole file', async () => {
    const hash = server.pdf.store(tinyPdf('read'))
    expect(pdfFiles.url(hash)).toBe(`/api/files/pdf/${hash}`)
    expect(new TextDecoder().decode(await pdfFiles.bytes(hash))).toContain('% read')
    expect(() => pdfFiles.url('../../etc/passwd')).toThrow(ApiError)
  })

  it('answers a Range request with 206 and that part', async () => {
    const hash = server.pdf.store(tinyPdf('range'))
    const res = await server.fetch(pdfFiles.url(hash), { headers: { Range: 'bytes=0-4' } })
    expect(res.status).toBe(206)
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe('%PDF-')
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
  })

  it('a Guest reads a PDF only when a Source on main refers to it', async () => {
    const hash = server.pdf.store(tinyPdf('guest'))
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
    server.actor = GUEST
    expect(await rejection(pdfFiles.bytes(hash))).toMatchObject({ status: 403 })
    server.commit([ops.createSource({ id: 's', url: 'https://x.org' }), ...pdfOps.attach('s', { hash, name: 'a.pdf', size: 3, pages: 1 })], ME.id)
    expect((await pdfFiles.bytes(hash)).length).toBeGreaterThan(0)
  })
})

describe('text', () => {
  it('putText stores the pages once; getText reads them; null when there is none', async () => {
    const hash = server.pdf.store(tinyPdf('t'))
    expect(await pdfFiles.getText(hash)).toBeNull()
    await pdfFiles.putText(hash, ['page one', 'page two'])
    await pdfFiles.putText(hash, ['changed'])
    expect(await pdfFiles.getText(hash)).toEqual(['page one', 'page two'])
    const put = server.requests.find((r) => r.method === 'PUT' && r.path.endsWith('/text'))
    expect(put?.body).toEqual({ pages: ['page one', 'page two'] })
  })

  it('putText refuses locally for a Guest', async () => {
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
    expect(await rejection(pdfFiles.putText(H, ['x']))).toMatchObject({ status: 403 })
  })

  it('fitText cuts pages so the JSON stays under the limit', () => {
    const pages = ['a'.repeat(400), 'b'.repeat(400), 'c']
    const cut = fitText(pages, 300)
    expect(JSON.stringify({ pages: cut }).length).toBeLessThanOrEqual(300)
    expect(cut).toHaveLength(3)
    expect(fitText(['short'], 300)).toEqual(['short'])
  })
})

describe('fetch from arXiv', () => {
  it('POSTs only the id and answers as an upload does', async () => {
    const bytes = tinyPdf('arxiv')
    server.pdf.arxiv['2103.05577'] = bytes
    const stored = await pdfFiles.fetchArxiv('2103.05577')
    expect(stored).toEqual({ hash: contentHash(bytes), size: bytes.length, pages: null })
    expect(server.requests.find((r) => r.path === '/api/sources/fetch-pdf')?.body).toEqual({ arxiv: '2103.05577' })
  })

  it('502 with the server’s sentence when arXiv does not answer', async () => {
    const e = await rejection(pdfFiles.fetchArxiv('2103.99999'))
    expect(e).toMatchObject({ status: 502, message: 'arXiv did not answer. Try again in a minute.' })
  })

  it('refuses locally what is not an arXiv id, and Guests', async () => {
    expect(await rejection(pdfFiles.fetchArxiv('https://evil.example/x'))).toMatchObject({ status: 400 })
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
    expect(await rejection(pdfFiles.fetchArxiv('2103.05577'))).toMatchObject({ status: 403 })
    expect(server.requests).toHaveLength(0)
  })
})

describe('search', () => {
  it('GET /api/search/pdf?q= → hits with page from 1 and a snippet', async () => {
    const hash = server.pdf.store(tinyPdf('s'))
    server.pdf.texts.set(hash, ['nothing here', 'the surface code threshold is about one percent'])
    const hits = await pdfFiles.search('  Threshold ')
    expect(hits).toEqual([{ hash, page: 2, snippet: expect.stringContaining('threshold') }])
    expect(server.requests[0]!.path).toBe('/api/search/pdf?q=Threshold')
  })

  it('asks nothing for fewer than 2 characters; drops items it cannot read', async () => {
    expect(await pdfFiles.search('a')).toEqual([])
    expect(server.requests).toHaveLength(0)
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([{ hash: H, page: 0 }, { hash: 'nope', page: 1 }, { hash: H.toUpperCase(), page: 3, snippet: 7 }]),
    }))
    expect(await pdfFiles.search('qq')).toEqual([{ hash: H, page: 3, snippet: '' }])
  })
})

describe('the fields on a Source', () => {
  const base = (): Entities => {
    const r = applyOps({}, [ops.createSource({ id: 's', url: 'https://arxiv.org/abs/2103.05577', title: 'Policies' })])
    if (!r.ok) throw new Error('setup')
    return r.entities
  }

  it('attach sets pdf, pdf_name, pdf_size and pdf_pages; the Source view model reads them', () => {
    const list = pdfOps.attach('s', { hash: H, name: '/Users/me/Downloads/2103.05577.pdf', size: 1234.4, pages: 12 })
    expect(list).toEqual([
      { Set: { entity: 's', field: 'pdf', value: { Text: H } } },
      { Set: { entity: 's', field: 'pdf_name', value: { Text: '2103.05577.pdf' } } },
      { Set: { entity: 's', field: 'pdf_size', value: { Float: 1234 } } },
      { Set: { entity: 's', field: 'pdf_pages', value: { Float: 12 } } },
    ])
    const r = applyOps(base(), list)
    if (!r.ok) throw new Error('apply')
    const vm = toPageIndex(r.entities).sources[0]!
    expect(vm).toMatchObject({ pdf: H, pdfName: '2103.05577.pdf', pdfSize: 1234, pdfPages: 12 })
    expect(sourcePdf(vm)).toEqual({ hash: H, name: '2103.05577.pdf', size: 1234, pages: 12 })
  })

  it('an unknown page count is left unset; remove clears all four', () => {
    const r = applyOps(base(), pdfOps.attach('s', { hash: H, name: 'a.pdf', size: 9, pages: null }))
    if (!r.ok) throw new Error('apply')
    const vm = toPageIndex(r.entities).sources[0]!
    expect(vm.pdfPages).toBeUndefined()
    expect(sourcePdf(vm)?.pages).toBeNull()
    const gone = applyOps(r.entities, pdfOps.remove('s'))
    if (!gone.ok) throw new Error('apply')
    const plain = toPageIndex(gone.entities).sources[0]!
    expect(plain.pdf).toBeUndefined()
    expect(sourcePdf(plain)).toBeNull()
    expect(Object.keys(plain)).not.toContain('pdfName')
  })

  it('a Source without a PDF keeps its identity across unrelated changes', () => {
    const e = base()
    const first = toPageIndex(e)
    const r = applyOps(e, [ops.createCard({ id: 'c', x: 0, y: 0 })])
    if (!r.ok) throw new Error('apply')
    expect(toPageIndex(r.entities, first).sources[0]).toBe(first.sources[0])
  })

  it('attach refuses a hash that is not one', () => {
    expect(() => pdfOps.attach('s', { hash: 'x', name: 'a', size: 1, pages: 1 })).toThrow()
  })

  it('pdfName keeps the last part of a path, without control characters', () => {
    expect(pdfName('C:\\Users\\me\\paper.pdf')).toBe('paper.pdf')
    expect(pdfName('a\u0000b.pdf')).toBe('a b.pdf')
    expect(pdfName('')).toBe('document.pdf')
  })

  it('isPdfBytes looks for %PDF- within the first KiB', () => {
    expect(isPdfBytes(new TextEncoder().encode('%PDF-1.7'))).toBe(true)
    expect(isPdfBytes(new TextEncoder().encode('junk\n%PDF-1.4'))).toBe(true)
    expect(isPdfBytes(new TextEncoder().encode('<html>'))).toBe(false)
  })
})
