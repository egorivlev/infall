import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './http'
import { membersStore } from './people'
import { session } from './session'
import { sessionStore } from './session-store'

const reply = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }))
const member = { id: 'm1', name: 'Ann', role: 'member' as const, color: '#abc' }
const err = (code: string) => ({ error: { code, message: 'x', detail: null } })

describe('session', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    sessionStore.setState({ status: 'loading' }, true)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('starts loading, then refresh signs in', async () => {
    expect(sessionStore.getState().status).toBe('loading')
    fetchMock.mockReturnValue(reply(200, { member }))
    await session.refresh()
    expect(sessionStore.getState()).toEqual({ status: 'signed_in', member })
  })
  it('refresh with 401 signs out', async () => {
    fetchMock.mockReturnValue(reply(401, err('not_signed_in')))
    await session.refresh()
    expect(sessionStore.getState().status).toBe('signed_out')
  })
  it('refresh never throws; a network failure while loading ends signed_out', async () => {
    fetchMock.mockRejectedValue(new TypeError('x'))
    await session.refresh()
    expect(sessionStore.getState().status).toBe('signed_out')
  })
  it('login success', async () => {
    fetchMock.mockReturnValue(reply(200, { member }))
    await session.login('a@b.c', 'pw')
    expect(sessionStore.getState().status).toBe('signed_in')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ email: 'a@b.c', password: 'pw' })
  })
  it('login failure leaves signed_out and throws', async () => {
    sessionStore.setState({ status: 'signed_out' }, true)
    fetchMock.mockReturnValue(reply(401, err('bad_credentials')))
    const e = await session.login('a@b.c', 'bad').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ApiError)
    expect((e as ApiError).code).toBe('bad_credentials')
    expect(sessionStore.getState().status).toBe('signed_out')
  })
  it('logout signs out and forgets the people list', async () => {
    sessionStore.setState({ status: 'signed_in', member }, true)
    membersStore.setState({ members: [member] })
    fetchMock.mockReturnValue(reply(200, {}))
    await session.logout()
    expect(sessionStore.getState().status).toBe('signed_out')
    expect(membersStore.getState().members).toEqual([])
  })
  it('acceptInvite signs in', async () => {
    fetchMock.mockReturnValue(reply(200, { member }))
    await session.acceptInvite('tok', 'Ann', 'long-enough-password')
    expect(sessionStore.getState().status).toBe('signed_in')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/accept-invite')
  })
})
