import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBoardSync } from './board-sync'
import { createBranches } from './branches'
import { branchesStore } from './branches-store'
import { ApiError } from './http'
import { ops } from './ops'
import { membersStore } from './people'
import { sessionStore } from './session-store'
import { FakeServer, FakeSocket, FakeTimers, GUEST, ME, OTHER, settle } from './testing'
import type { Op } from './types'

let server: FakeServer
let timers: FakeTimers
let sync: ReturnType<typeof createBoardSync>
let branches: ReturnType<typeof createBranches>

const snap = () => sync.store.getState().snapshot
const list = () => branchesStore.getState().branches
const card = (id: string, title?: string): Op => ops.createCard({ id, x: 0, y: 0, title })

async function openLive(name?: string) {
  await sync.open(name)
  const ws = FakeSocket.last()
  ws.open()
  const b = server.find(name)
  ws.receive({ type: 'subscribed', branch: b.info.id, seq: b.log.length })
  await settle()
  return ws
}

beforeEach(() => {
  server = new FakeServer()
  timers = new FakeTimers()
  FakeSocket.all = []
  vi.stubGlobal('fetch', server.fetch)
  sessionStore.setState({ status: 'signed_in', member: ME }, true)
  membersStore.setState({ members: [] })
  branchesStore.setState({ branches: [] })
  sync = createBoardSync({
    WebSocketCtor: FakeSocket,
    setTimer: timers.set,
    clearTimer: timers.clear,
    socketUrl: () => 'ws://test/api/ws',
  })
  branches = createBranches(sync)
})

afterEach(() => {
  sync.close()
  vi.unstubAllGlobals()
})

describe('branches', () => {
  it('is empty until reload, then holds the list', async () => {
    server.commit([card('a')], OTHER.id)
    server.checkpoint('first')
    expect(list()).toEqual([])
    await branches.reload()
    expect(list()).toEqual([{ id: 'main-id', name: 'main', seq: 1, checkpoints: 1 }])
  })
  it('keeps the array identity when a reload changes nothing', async () => {
    await branches.reload()
    const before = list()
    await branches.reload()
    expect(list()).toBe(before)
  })
  it('is filled by board.open()', async () => {
    await sync.open()
    expect(list().map((b) => b.name)).toEqual(['main'])
  })
  it('creates a Branch from the head of the open Branch by default, without switching', async () => {
    server.commit([card('a'), card('b')], OTHER.id)
    await openLive()
    const made = await branches.create({ name: 'idea' })
    expect(made).toMatchObject({ id: 'idea-id', name: 'idea', seq: 0, parent: { branch: 'main-id', seq: 2 } })
    expect(server.requests.at(-1)).toMatchObject({
      method: 'POST',
      path: '/api/branches',
      body: { name: 'idea', from: { branch: 'main-id', seq: 2 } },
    })
    expect(list().map((b) => b.name)).toEqual(['main', 'idea'])
    expect(snap().branch?.name).toBe('main')
  })
  it('creates a Branch from a given moment', async () => {
    server.commit([card('a'), card('b')], OTHER.id)
    await branches.create({ name: 'early', from: { branch: 'main-id', seq: 1 } })
    expect(Object.keys(server.find('early').entities)).toEqual(['a'])
  })
  it('needs an open Board when no moment is given', async () => {
    await expect(branches.create({ name: 'x' })).rejects.toMatchObject({ status: 400, code: 'board_not_open' })
    expect(server.requests).toEqual([])
  })
  it('rejects with the server error for a taken or bad name', async () => {
    await openLive()
    await expect(branches.create({ name: 'main' })).rejects.toMatchObject({ status: 409, code: 'name_taken' })
    await expect(branches.create({ name: '  ' })).rejects.toMatchObject({ status: 400 })
    await expect(branches.create({ name: 'x', from: { branch: 'main-id', seq: 9 } })).rejects.toBeInstanceOf(ApiError)
    expect(list().map((b) => b.name)).toEqual(['main'])
  })
  it('takes the list from the socket `branches` frame', async () => {
    const ws = await openLive()
    server.fork('theirs', { branch: 'main-id', seq: 0 }, OTHER.id)
    ws.receive(server.branchesFrame())
    expect(list().map((b) => b.name)).toEqual(['main', 'theirs'])
    expect(list()[1]).toMatchObject({ created_by: 'other', parent: { branch: 'main-id', seq: 0 } })
  })
  it('does not duplicate a created Branch when the frame also arrives', async () => {
    const ws = await openLive()
    await branches.create({ name: 'idea' })
    ws.receive(server.branchesFrame())
    expect(list().map((b) => b.name)).toEqual(['main', 'idea'])
  })
  it('forgets the list when the session ends', async () => {
    await branches.reload()
    sessionStore.setState({ status: 'signed_out' }, true)
    expect(list()).toEqual([])
  })
})

describe('Guests', () => {
  beforeEach(() => {
    server.actor = GUEST
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
  })
  it('cannot create a Branch; nothing is sent', async () => {
    await openLive()
    const sent = server.requests.length
    await expect(branches.create({ name: 'x' })).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    expect(server.requests).toHaveLength(sent)
  })
  it('keep an empty list through reload, board.open and frames', async () => {
    await branches.reload()
    expect(server.requests).toEqual([])
    const ws = await openLive()
    ws.receive(server.branchesFrame())
    expect(list()).toEqual([])
    expect(snap().branch?.name).toBe('main')
    expect(snap().readOnly).toBe(true)
  })
})

describe('board: switching Branch', () => {
  it('opens another Branch: closes the old socket and shows the other Board', async () => {
    server.commit([card('a', 'A')], OTHER.id)
    server.fork('idea', { branch: 'main-id', seq: 1 })
    server.commit([card('b', 'B')], OTHER.id, 'idea')
    const first = await openLive()
    expect(snap().cards.map((c) => c.id)).toEqual(['a'])
    const second = await openLive('idea')
    expect(first.closed).toBe(true)
    expect(second).not.toBe(first)
    expect(second.sent).toEqual([{ type: 'subscribe', branch: 'idea-id', after: 1 }])
    expect(snap()).toMatchObject({ status: 'live', seq: 1 })
    expect(snap().branch).toMatchObject({ id: 'idea-id', name: 'idea', parent: { branch: 'main-id', seq: 1 } })
    expect(snap().cards.map((c) => c.id)).toEqual(['a', 'b'])
  })
  it('ignores frames of the Branch it left', async () => {
    server.fork('idea', { branch: 'main-id', seq: 0 })
    await openLive()
    const ws = await openLive('idea')
    ws.receive(server.external([card('m')])) // a main-id frame on the new socket
    expect(snap().cards).toEqual([])
    expect(snap().seq).toBe(0)
  })
  it('rejects submits still pending on the old Branch and never applies them to the new one', async () => {
    server.fork('idea', { branch: 'main-id', seq: 0 })
    await openLive()
    let release!: () => void
    server.gate = new Promise<void>((r) => (release = r))
    const pending = sync.submit([card('x')])
    const queued = sync.submit([card('y')])
    const results = Promise.allSettled([pending, queued])
    await openLive('idea')
    for (const r of await results) {
      expect(r).toMatchObject({ status: 'rejected', reason: { code: 'closed' } })
    }
    release()
    server.gate = null
    await settle()
    expect(snap().cards).toEqual([])
    expect(snap().pending).toBe(0)
    expect(snap().branch?.name).toBe('idea')
  })
  it('submits to the Branch that is open', async () => {
    server.fork('idea', { branch: 'main-id', seq: 0 })
    await openLive('idea')
    await sync.submit([card('x')])
    expect(server.requests.at(-1)?.path).toBe('/api/branches/idea-id/ops')
    expect(server.find('idea').log).toHaveLength(1)
    expect(server.log).toHaveLength(0)
  })
  it('rejects with ApiError 404 for an unknown name and ends in error', async () => {
    await openLive()
    const err = await sync.open('nope').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 404, code: 'not_found' })
    expect(snap().status).toBe('error')
    expect(snap().branch).toBeUndefined()
    expect(snap().cards).toEqual([])
  })
  it('lets the last of two overlapping opens win', async () => {
    server.commit([card('a')], OTHER.id)
    server.fork('idea', { branch: 'main-id', seq: 0 })
    const one = sync.open('main')
    const two = sync.open('idea')
    await Promise.all([one, two])
    expect(snap().branch?.name).toBe('idea')
    expect(snap().cards).toEqual([])
    expect(FakeSocket.all).toHaveLength(1)
  })
})

describe('board: branch info stays current', () => {
  it('follows seq as Changes are confirmed', async () => {
    const ws = await openLive()
    expect(snap().branch).toMatchObject({ seq: 0, checkpoints: 0 })
    ws.receive(server.external([card('a'), card('b')]))
    expect(snap().branch?.seq).toBe(2)
    await sync.submit([card('c')])
    expect(snap().branch?.seq).toBe(3)
  })
  it('starts from the count in the Branch list and counts `checkpoint` frames once each', async () => {
    server.checkpoint('before')
    const ws = await openLive()
    expect(snap().branch?.checkpoints).toBe(1)
    const cp = server.checkpoint('later', 0, OTHER.id)
    ws.receive(server.checkpointFrame(cp))
    expect(snap().branch?.checkpoints).toBe(2)
    ws.receive(server.checkpointFrame(cp))
    expect(snap().branch?.checkpoints).toBe(2)
  })
  it('ignores a `checkpoint` frame of another Branch', async () => {
    const other = server.fork('idea', { branch: 'main-id', seq: 0 })
    const ws = await openLive()
    ws.receive(server.checkpointFrame(server.checkpoint('theirs', 0, OTHER.id, other.info.id)))
    expect(snap().branch?.checkpoints).toBe(0)
  })
  it('keeps its own seq and the larger Checkpoint count when a `branches` frame arrives', async () => {
    const ws = await openLive()
    ws.receive(server.checkpointFrame(server.checkpoint('one')))
    ws.receive(server.external([card('a')]))
    const frame = server.branchesFrame()
    if (frame.type !== 'branches') throw new Error('unreachable')
    frame.branches[0] = { ...frame.branches[0]!, seq: 0, checkpoints: 0 } // a list computed a moment earlier
    ws.receive(frame)
    expect(snap().branch).toMatchObject({ seq: 1, checkpoints: 1 })
  })
  it('asks for the Branch list again after a reconnect, since missed frames are not repeated', async () => {
    const ws = await openLive()
    const asked = () => server.requests.filter((r) => r.path === '/api/branches').length
    expect(asked()).toBe(1)
    ws.drop()
    server.checkpoint('while away', 0, OTHER.id)
    server.fork('idea', { branch: 'main-id', seq: 0 }, OTHER.id)
    timers.fireNext()
    const next = FakeSocket.last()
    next.open()
    next.receive({ type: 'subscribed', branch: 'main-id', seq: 0 })
    await settle()
    expect(asked()).toBe(2)
    expect(snap().branch?.checkpoints).toBe(1)
    expect(list().map((b) => b.name)).toEqual(['main', 'idea'])
  })
  it('ignores frame types it does not know', async () => {
    const ws = await openLive()
    const before = snap()
    ws.onmessage?.({ data: JSON.stringify({ type: 'something_new', branch: 'main-id' }) })
    expect(snap()).toBe(before)
  })
})
