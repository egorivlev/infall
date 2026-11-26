import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './http'
import { sessionStore } from './session-store'
import { FakeServer, GUEST, ME, OTHER } from './testing'
import { toolEndpoint, tokens } from './tokens'

let server: FakeServer

const calls = () => server.requests.filter((r) => r.path.startsWith('/api/tokens'))

beforeEach(() => {
  server = new FakeServer()
  vi.stubGlobal('fetch', server.fetch)
  sessionStore.setState({ status: 'signed_in', member: ME }, true)
  server.now = 100
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('tokens', () => {
  it('creates a token and hands out its secret once', async () => {
    const made = await tokens.create('  Claude on my laptop ')
    expect(made).toEqual({ token: { id: 'k0', name: 'Claude on my laptop', created_at: 100 }, secret: server.secrets[0] })
    expect(made.secret).toMatch(/^infall_pat_[A-Za-z0-9_-]{43}$/)
    expect(calls()).toEqual([{ method: 'POST', path: '/api/tokens', body: { name: 'Claude on my laptop' } }])
    expect(JSON.stringify(await tokens.list())).not.toContain('infall_pat_')
  })
  it('lists the Member\'s own tokens, oldest first', async () => {
    expect(await tokens.list()).toEqual([])
    await tokens.create('First')
    server.tokens.push({ id: 'theirs', name: 'Not mine', created_at: 150, member: OTHER.id })
    server.now = 200
    await tokens.create('Second')
    server.tokens[0]!.last_used_at = 180
    expect(await tokens.list()).toEqual([
      { id: 'k0', name: 'First', created_at: 100, last_used_at: 180 },
      { id: 'k1', name: 'Second', created_at: 200 },
    ])
    expect(calls().filter((r) => r.method === 'GET')).toEqual([
      { method: 'GET', path: '/api/tokens', body: undefined },
      { method: 'GET', path: '/api/tokens', body: undefined },
    ])
  })
  it('removes a token', async () => {
    await tokens.create('Old laptop')
    await tokens.remove('k0')
    expect(calls()[1]).toEqual({ method: 'DELETE', path: '/api/tokens/k0', body: undefined })
    expect(await tokens.list()).toEqual([])
    server.tokens.push({ id: 'a/b', name: 'Odd id', created_at: 1, member: ME.id })
    await tokens.remove('a/b')
    expect(calls().at(-1)!.path).toBe('/api/tokens/a%2Fb')
    expect(server.tokens).toEqual([])
  })
  it('refuses a name that is empty or over 60 characters without a request', async () => {
    await expect(tokens.create('   ')).rejects.toMatchObject({ status: 400, code: 'bad_request' })
    await expect(tokens.create('x'.repeat(61))).rejects.toMatchObject({ status: 400, code: 'bad_request' })
    expect(calls()).toEqual([])
    await tokens.create('x'.repeat(60))
    expect(server.tokens).toHaveLength(1)
  })
  it('rejects with what the server says', async () => {
    for (let i = 0; i < 10; i++) await tokens.create(`Token ${i}`)
    const error = await tokens.create('One too many').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 400, code: 'bad_request' })
    await expect(tokens.remove('ghost')).rejects.toMatchObject({ status: 404, code: 'not_found' })
    server.tokens.push({ id: 'theirs', name: 'Not mine', created_at: 150, member: OTHER.id })
    await expect(tokens.remove('theirs')).rejects.toMatchObject({ status: 404, code: 'not_found' })
    server.tokenFail = { status: 500, code: 'internal' }
    await expect(tokens.remove('k0')).rejects.toMatchObject({ status: 500, code: 'internal' })
    expect(server.tokens.some((t) => t.id === 'k0')).toBe(true)
  })
  it('rejects on a network failure, and a 401 ends the session', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('down')))
    await expect(tokens.list()).rejects.toMatchObject({ status: 0, code: 'network' })
    await expect(tokens.create('Offline')).rejects.toMatchObject({ status: 0, code: 'network' })
    await expect(tokens.remove('k0')).rejects.toMatchObject({ status: 0, code: 'network' })
    vi.stubGlobal('fetch', server.fetch)
    server.tokenFail = { status: 401, code: 'unauthorized' }
    await expect(tokens.create('Signed out meanwhile')).rejects.toMatchObject({ status: 401 })
    expect(sessionStore.getState().status).toBe('signed_out')
  })
  it('refuses everything for a Guest and a signed-out session, without a request', async () => {
    const refused = { status: 403, code: 'forbidden' }
    for (const state of [{ status: 'signed_in', member: GUEST }, { status: 'signed_out' }] as const) {
      sessionStore.setState(state, true)
      await expect(tokens.list()).rejects.toMatchObject(refused)
      await expect(tokens.create('For a Guest')).rejects.toMatchObject(refused)
      await expect(tokens.remove('k0')).rejects.toMatchObject(refused)
    }
    expect(calls()).toEqual([])
  })
})

describe('toolEndpoint', () => {
  it('is /mcp on the origin the app is served from', () => {
    expect(toolEndpoint()).toBe(`${globalThis.location.origin}/mcp`)
    expect(toolEndpoint()).toMatch(/^https?:\/\/[^/]+\/mcp$/)
  })
})
