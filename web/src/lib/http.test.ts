import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, request } from './http'
import { sessionStore } from './session-store'

const reply = (status: number, body: unknown) =>
  Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }))

describe('http.request', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    sessionStore.setState({ status: 'loading' }, true)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('GET sends credentials and no CSRF header', async () => {
    fetchMock.mockReturnValue(reply(200, { a: 1 }))
    expect(await request('GET', '/api/me')).toEqual({ a: 1 })
    const [path, init] = fetchMock.mock.calls[0]
    expect(path).toBe('/api/me')
    expect(init.credentials).toBe('same-origin')
    expect(init.headers['X-Infall-Request']).toBeUndefined()
    expect(init.body).toBeUndefined()
  })
  it('non-GET sends the header and a JSON body', async () => {
    fetchMock.mockImplementation(() => reply(200, {}))
    await request('POST', '/api/x', { k: 'v' })
    const init = fetchMock.mock.calls[0][1]
    expect(init.method).toBe('POST')
    expect(init.headers['X-Infall-Request']).toBe('1')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(init.body).toBe('{"k":"v"}')
    await request('DELETE', '/api/x/1')
    expect(fetchMock.mock.calls[1][1].headers['X-Infall-Request']).toBe('1')
  })
  it('maps the error body to ApiError', async () => {
    fetchMock.mockReturnValue(
      reply(409, { error: { code: 'rejected', message: 'No.', detail: { code: 'x' } } }),
    )
    const e = await request('POST', '/api/x', {}).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ApiError)
    expect(e).toMatchObject({ status: 409, code: 'rejected', message: 'No.', detail: { code: 'x' } })
  })
  it('copes with a non-JSON error body', async () => {
    fetchMock.mockReturnValue(reply(502, '<html>bad gateway</html>'))
    await expect(request('GET', '/api/x')).rejects.toMatchObject({ status: 502, code: 'http_502' })
  })
  it('a 401 flips the session to signed_out', async () => {
    sessionStore.setState({ status: 'signed_in', member: { id: 'm', name: 'M', role: 'member', color: '#000' } }, true)
    fetchMock.mockReturnValue(reply(401, { error: { code: 'not_signed_in', message: 'Sign in.', detail: null } }))
    await expect(request('GET', '/api/members')).rejects.toMatchObject({ status: 401, code: 'not_signed_in' })
    expect(sessionStore.getState().status).toBe('signed_out')
  })
  it('a network failure is ApiError status 0', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(request('GET', '/api/x')).rejects.toMatchObject({ status: 0, code: 'network' })
    expect(sessionStore.getState().status).toBe('loading')
  })
})
