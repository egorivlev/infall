// M18 (docs/specs/team-move.md, Contract B): an empty Team server, bringing in and taking out a Workspace file,
// a moved copy that is read-only, and invites that claim a name.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBoardSync } from './board-sync'
import { dispositionName, movedRefusals } from './http'
import { invites, membersStore } from './people'
import { sessionStore } from './session-store'
import { FakeServer, FakeSocket, FakeTimers, ME, OTHER, settle } from './testing'
import { todos, todosInternal } from './todos'
import type { Member } from './types'
import { workspace, workspaceStore } from './workspace'

const ADMIN: Member = { ...ME, role: 'admin' }
let server: FakeServer
const now = () => workspaceStore.getState()

beforeEach(() => {
  server = new FakeServer()
  server.actor = ADMIN
  server.members = [ADMIN, OTHER]
  vi.stubGlobal('fetch', server.fetch)
  vi.stubGlobal('XMLHttpRequest', server.xhr())
  sessionStore.setState({ status: 'signed_out' }, true)
  sessionStore.setState({ status: 'signed_in', member: ADMIN }, true)
  membersStore.setState({ members: [] })
  todosInternal.reset()
})

afterEach(() => {
  sessionStore.setState({ status: 'signed_out' }, true)
  vi.unstubAllGlobals()
})

describe('GET /api/workspace', () => {
  it('reads empty and read_only; both false unless the server says true', async () => {
    server.workspace = { kind: 'team', preset: null, empty: true }
    await workspace.load()
    expect(now()).toMatchObject({ kind: 'team', empty: true, readOnly: false, movedTo: null })
  })
  it('a Local Workspace is never empty; a moved one is read-only and may say where it went', async () => {
    server.workspace = { kind: 'local', preset: 'blank', empty: true, read_only: true, moved_to: 'https://lab.example.org' }
    await workspace.load()
    expect(now()).toMatchObject({ kind: 'local', empty: false, readOnly: true, movedTo: 'https://lab.example.org' })
  })
  it('Start empty steps aside without asking the server', async () => {
    server.workspace = { kind: 'team', preset: null, empty: true }
    await workspace.load()
    const before = server.requests.length
    workspace.startEmpty()
    expect(now().empty).toBe(false)
    expect(server.requests.length).toBe(before)
  })
})

describe('bringing in a Workspace file', () => {
  beforeEach(async () => {
    server.workspace = { kind: 'team', preset: null, empty: true }
    await workspace.load()
  })

  it('uploads the bytes with progress, answers the members, and leaves the server not empty', async () => {
    server.importAnswer = {
      members: [
        { id: ADMIN.id, name: ADMIN.name, claimed: true },
        { id: 'ana', name: 'Ana Ruiz', claimed: false },
      ],
      you_were: 'Elena on her laptop',
    }
    const bytes = new Uint8Array(1000).fill(7)
    const seen: [number, number][] = []
    const answer = await workspace.importFile(bytes, { onProgress: (s, t) => seen.push([s, t]) })
    expect(answer).toEqual(server.importAnswer)
    expect(seen.at(-1)).toEqual([1000, 1000])
    expect(seen.length).toBeGreaterThan(2)
    const sent = server.imported[0] as Blob
    expect(sent.size).toBe(1000)
    expect(now().empty).toBe(false)
    expect(membersStore.getState().members.find((m) => m.id === 'ana')).toMatchObject({ name: 'Ana Ruiz', claimed: false })
  })

  it('passes on the server’s sentence: not a Workspace file, not empty, too new', async () => {
    server.importFail = { status: 400, code: 'not_a_workspace_file', message: 'This is not a Workspace file.' }
    await expect(workspace.importFile(new Uint8Array([1]))).rejects.toMatchObject({ status: 400, code: 'not_a_workspace_file', message: 'This is not a Workspace file.' })
    server.importFail = { status: 422, code: 'newer_version', message: 'This file was made by a newer Infall.' }
    await expect(workspace.importFile(new Uint8Array([1]))).rejects.toMatchObject({ status: 422 })
    server.workspace = { kind: 'team', preset: null, empty: false }
    await expect(workspace.importFile(new Uint8Array([1]))).rejects.toMatchObject({ status: 409, code: 'not_empty' })
  })

  it('refuses locally for anyone but an Admin, and for an empty file', async () => {
    await expect(workspace.importFile(new Uint8Array(0))).rejects.toMatchObject({ status: 400 })
    sessionStore.setState({ status: 'signed_in', member: { ...ADMIN, role: 'member' } }, true)
    await expect(workspace.importFile(new Uint8Array([1]))).rejects.toMatchObject({ status: 403 })
    expect(server.imported).toEqual([])
  })

  it('works with fetch where there is no XMLHttpRequest (progress only at the end)', async () => {
    vi.stubGlobal('XMLHttpRequest', undefined)
    const seen: number[] = []
    await workspace.importFile(new Blob([new Uint8Array(10)]), { onProgress: (s) => seen.push(s) })
    expect(seen).toEqual([10])
    expect(server.imported.length).toBe(1)
  })

  it('can be stopped', async () => {
    let release!: () => void
    server.uploadGate = new Promise<void>((r) => (release = r))
    const stop = new AbortController()
    const run = workspace.importFile(new Uint8Array(100), { signal: stop.signal })
    await settle()
    stop.abort()
    release()
    await expect(run).rejects.toMatchObject({ status: 0, code: 'aborted' })
  })
})

describe('exporting a Workspace file', () => {
  it('gives the bytes and the server’s name', async () => {
    const file = await workspace.exportFile()
    expect(file.name).toBe('Physics group.infall')
    expect([...file.bytes]).toEqual([...server.exportBytes])
  })
  it('is for Admins only', async () => {
    sessionStore.setState({ status: 'signed_in', member: ME }, true)
    await expect(workspace.exportFile()).rejects.toMatchObject({ status: 403 })
  })
  it('reads both forms of Content-Disposition', () => {
    expect(dispositionName('attachment; filename="Lab \\"A\\".infall"')).toBe('Lab "A".infall')
    expect(dispositionName("attachment; filename*=UTF-8''Gr%C3%BCn.infall; filename=\"x\"")).toBe('Grün.infall')
    expect(dispositionName('attachment')).toBeNull()
    expect(dispositionName(null)).toBeNull()
  })
})

describe('a moved Workspace', () => {
  let timers: FakeTimers
  let sync: ReturnType<typeof createBoardSync>

  beforeEach(async () => {
    sessionStore.setState({ status: 'signed_in', member: ME }, true)
    server.actor = ME
    server.workspace = { kind: 'local', preset: null, read_only: true }
    await workspace.load()
    timers = new FakeTimers()
    FakeSocket.all = []
    sync = createBoardSync({ WebSocketCtor: FakeSocket, setTimer: timers.set, clearTimer: timers.clear, socketUrl: () => 'ws://t' })
  })
  afterEach(() => sync.close())

  it('reads as a read-only Board, and refuses a submit without asking', async () => {
    await sync.open()
    expect(sync.store.getState().snapshot.readOnly).toBe(true)
    const before = server.requests.length
    await expect(sync.submit([{ Delete: { entity: 'x' } }])).rejects.toMatchObject({ status: 403, code: 'moved' })
    expect(server.requests.length).toBe(before)
  })

  it('To-dos refuse too', async () => {
    server.addTodo({ owner: ME.id, text: 'x' })
    await todos.reload()
    await expect(todos.add({ owner: ME.id, text: 'y' })).rejects.toMatchObject({ code: 'moved' })
  })

  it('a 403 moved from the server makes the Workspace read-only, and is counted once per refusal', async () => {
    workspaceStore.setState({ ...now(), readOnly: false }, true)
    await sync.open()
    expect(sync.store.getState().snapshot.readOnly).toBe(false)
    movedRefusals.reset()
    await expect(sync.submit([{ Create: { entity: 'k', kind: 'Card', fields: {} } }])).rejects.toMatchObject({ code: 'moved' })
    expect(movedRefusals.current()).toEqual({ sentence: 'This Workspace was moved to a Team server; open it there to make changes.', refusals: 1 })
    expect(now().readOnly).toBe(true)
    expect(sync.store.getState().snapshot.readOnly).toBe(true)
  })
})

describe('invites that claim a name', () => {
  it('send claims only when given, and the server checks it names an unclaimed Member', async () => {
    server.members = [ADMIN, { id: 'ana', name: 'Ana Ruiz', role: 'member', color: '#777', claimed: false }]
    const { invite } = await invites.create({ email: 'ana@lab.org', role: 'member', claims: 'ana' })
    expect(invite.claims).toBe('ana')
    expect(server.requests.at(-1)?.body).toEqual({ email: 'ana@lab.org', role: 'member', claims: 'ana' })
    await invites.create({ email: 'ben@lab.org', role: 'member' })
    expect(server.requests.at(-1)?.body).toEqual({ email: 'ben@lab.org', role: 'member' })
    await expect(invites.create({ email: 'x@lab.org', role: 'member', claims: ADMIN.id })).rejects.toMatchObject({ status: 400 })
  })
})
