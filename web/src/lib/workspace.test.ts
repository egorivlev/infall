import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './http'
import { membersStore } from './people'
import { sessionStore } from './session-store'
import { FakeServer, ME, OTHER, settle } from './testing'
import { workspace, workspaceStore } from './workspace'

let server: FakeServer
const now = () => workspaceStore.getState()
const TEAM = { kind: 'team', preset: null, empty: false, readOnly: false, movedTo: null }
const asked = () => server.requests.filter((r) => r.path === '/api/workspace').length

beforeEach(() => {
  server = new FakeServer()
  vi.stubGlobal('fetch', server.fetch)
  sessionStore.setState({ status: 'signed_out' }, true)
  sessionStore.setState({ status: 'signed_in', member: ME }, true)
  membersStore.setState({ members: [] })
})

afterEach(() => {
  sessionStore.setState({ status: 'signed_out' }, true)
  vi.unstubAllGlobals()
})

describe('the kind of Workspace', () => {
  it('reads as a Team Workspace until the server has answered', async () => {
    expect(now()).toEqual({ status: 'idle', ...TEAM })
    server.workspace = { kind: 'local', preset: 'tutorial' }
    const loading = workspace.load()
    expect(now()).toEqual({ status: 'loading', ...TEAM })
    await loading
    expect(now()).toEqual({ status: 'ready', ...TEAM, kind: 'local', preset: 'tutorial' })
  })

  it('a server from before M12 (404) is a Team Workspace', async () => {
    server.workspace = null
    await workspace.load()
    expect(now()).toEqual({ status: 'ready', ...TEAM })
  })

  it('so is a server that cannot be reached, or one that answers something odd', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')))
    await workspace.load()
    expect(now()).toEqual({ status: 'ready', ...TEAM })

    sessionStore.setState({ status: 'signed_out' }, true)
    sessionStore.setState({ status: 'signed_in', member: ME }, true)
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, text: async () => '{"kind":"moon","preset":7}' }) as Response)
    await workspace.load()
    expect(now()).toEqual({ status: 'ready', ...TEAM })
  })

  it('is asked once per session, and forgotten when the session ends', async () => {
    server.workspace = { kind: 'local', preset: 'blank' }
    await workspace.load()
    await workspace.load()
    expect(asked()).toBe(1)
    sessionStore.setState({ status: 'signed_out' }, true)
    expect(now().status).toBe('idle')
    await workspace.load() // signed out: nothing to ask
    expect(asked()).toBe(1)
    sessionStore.setState({ status: 'signed_in', member: ME }, true)
    await workspace.load()
    expect(asked()).toBe(2)
  })

  it('an answer that arrives after the session ended is dropped', async () => {
    server.workspace = { kind: 'local', preset: 'tutorial' }
    const loading = workspace.load()
    sessionStore.setState({ status: 'signed_out' }, true)
    await loading
    expect(now()).toEqual({ status: 'idle', ...TEAM })
  })

  it('a Preset is only read for a Local Workspace', async () => {
    server.workspace = { kind: 'team', preset: 'tutorial' }
    await workspace.load()
    expect(now().preset).toBeNull()
  })
})

describe('changing the name of the one Member', () => {
  beforeEach(() => {
    server.workspace = { kind: 'local', preset: 'tutorial' }
  })

  it('sends it trimmed, and shows it at once in the session and the Member list', async () => {
    membersStore.setState({ members: [ME, OTHER] })
    await expect(workspace.rename('  Ana Ruiz ')).resolves.toBe('Ana Ruiz')
    expect(server.requests.at(-1)).toEqual({ method: 'PATCH', path: '/api/local/member', body: { name: 'Ana Ruiz' } })
    const s = sessionStore.getState()
    expect(s.status === 'signed_in' && s.member).toEqual({ ...ME, name: 'Ana Ruiz' })
    expect(membersStore.getState().members).toEqual([{ ...ME, name: 'Ana Ruiz' }, OTHER])
  })

  it('refuses an empty or too long name without asking', async () => {
    const before = server.requests.length
    await expect(workspace.rename('   ')).rejects.toMatchObject({ status: 400, code: 'bad_request' })
    await expect(workspace.rename('x'.repeat(101))).rejects.toBeInstanceOf(ApiError)
    expect(server.requests.length).toBe(before)
  })

  it('passes on what the server refuses, and changes nothing', async () => {
    server.localFail = { status: 403, code: 'forbidden' }
    await expect(workspace.rename('Ana')).rejects.toMatchObject({ status: 403 })
    const s = sessionStore.getState()
    expect(s.status === 'signed_in' && s.member.name).toBe(ME.name)
  })

  it('is 404 on a Team Workspace', async () => {
    server.workspace = { kind: 'team', preset: null }
    await expect(workspace.rename('Ana')).rejects.toMatchObject({ status: 404 })
  })
})

describe('the Tutorial’s progress', () => {
  it('is null at first, and comes back as it was stored', async () => {
    server.workspace = { kind: 'local', preset: 'tutorial' }
    await expect(workspace.loadTutorial()).resolves.toBeNull()
    await workspace.saveTutorial({ v: 1, step: 'card' })
    await settle()
    expect(server.tutorialState).toEqual({ v: 1, step: 'card' })
    await expect(workspace.loadTutorial()).resolves.toEqual({ v: 1, step: 'card' })
  })
})
