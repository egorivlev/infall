import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './http'
import { lookupQuery, lookupSource } from './lookup'
import { sessionStore } from './session-store'
import { FakeServer, GUEST, ME } from './testing'

let server: FakeServer

beforeEach(() => {
  server = new FakeServer()
  vi.stubGlobal('fetch', server.fetch)
  sessionStore.setState({ status: 'signed_in', member: ME }, true)
})

afterEach(() => {
  sessionStore.setState({ status: 'signed_out' }, true)
  vi.unstubAllGlobals()
})

describe('lookupQuery', () => {
  it('recognises DOIs however they are written', () => {
    expect(lookupQuery('10.1103/PhysRevA.52.R2493')).toEqual({ doi: '10.1103/physreva.52.r2493' })
    expect(lookupQuery(' doi:10.1103/PhysRevA.52.R2493 ')).toEqual({ doi: '10.1103/physreva.52.r2493' })
    expect(lookupQuery('https://doi.org/10.22331/q-2020-02-06-226')).toEqual({ doi: '10.22331/q-2020-02-06-226' })
  })

  it('recognises arXiv ids and addresses, dropping the version', () => {
    expect(lookupQuery('2103.05577')).toEqual({ arxiv: '2103.05577' })
    expect(lookupQuery('arXiv:2103.05577v2')).toEqual({ arxiv: '2103.05577' })
    expect(lookupQuery('https://arxiv.org/abs/2103.05577v3')).toEqual({ arxiv: '2103.05577' })
    expect(lookupQuery('https://arxiv.org/pdf/2103.05577.pdf')).toEqual({ arxiv: '2103.05577' })
    expect(lookupQuery('http://export.arxiv.org/abs/quant-ph/0101001')).toEqual({ arxiv: 'quant-ph/0101001' })
    expect(lookupQuery('math.GT/0309136')).toEqual({ arxiv: 'math.GT/0309136' })
    expect(lookupQuery('0704.0001')).toEqual({ arxiv: '0704.0001' })
  })

  it('asks arXiv for an arXiv DOI, which Crossref does not know', () => {
    expect(lookupQuery('10.48550/arXiv.2103.05577')).toEqual({ arxiv: '2103.05577' })
  })

  it('is null for anything else', () => {
    for (const t of ['', 'hello', 'https://example.org/paper', '2103.055', 'https://arxiv.org/list/quant-ph/new', '10.1/x']) expect(lookupQuery(t)).toBeNull()
  })
})

describe('lookupSource', () => {
  const found = { title: 'Parametrized quantum policies', authors: 'Sofiene Jerbi, Vedran Dunjko', year: '2021', doi: null, url: 'https://arxiv.org/abs/2103.05577' }

  it('asks the server with exactly one key and passes the answer on', async () => {
    server.lookups['2103.05577'] = found
    await expect(lookupSource({ arxiv: '2103.05577' })).resolves.toEqual(found)
    expect(server.requests.at(-1)).toEqual({ method: 'POST', path: '/api/sources/lookup', body: { arxiv: '2103.05577' } })
    server.lookups['10.1/abc'] = { ...found, doi: '10.1/abc', url: null }
    await expect(lookupSource({ doi: '10.1/abc' })).resolves.toMatchObject({ doi: '10.1/abc', url: null })
    expect(server.requests.at(-1)!.body).toEqual({ doi: '10.1/abc' })
  })

  it('reads missing or odd fields as empty', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, text: async () => '{"title":" T ","year":2021,"doi":""}' }) as Response)
    await expect(lookupSource({ doi: '10.1/x' })).resolves.toEqual({ title: 'T', authors: '', year: '', doi: null, url: null })
  })

  it('rejects with the server’s sentence', async () => {
    await expect(lookupSource({ doi: '10.1/none' })).rejects.toMatchObject({ status: 404, message: 'The registry does not know this one.' })
    server.lookupFail = { status: 502, code: 'upstream', message: 'Crossref did not answer. Try again in a minute.' }
    await expect(lookupSource({ doi: '10.1/x' })).rejects.toMatchObject({ status: 502, message: 'Crossref did not answer. Try again in a minute.' })
    server.lookupFail = { status: 429, code: 'too_many', message: 'Wait a minute.' }
    await expect(lookupSource({ doi: '10.1/x' })).rejects.toMatchObject({ status: 429 })
  })

  it('rejects with status 0 when the server cannot be reached', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')))
    const e = await lookupSource({ doi: '10.1/x' }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ApiError)
    expect((e as ApiError).status).toBe(0)
  })

  it('is refused for a Guest without asking', async () => {
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
    await expect(lookupSource({ doi: '10.1/x' })).rejects.toMatchObject({ status: 403 })
    expect(server.requests).toEqual([])
  })
})
