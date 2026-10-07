// M6: a Guest reads the present main Branch and nothing else (api.md §13). The Board comes whole, without deleted
// entities; the socket only says `refresh`.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { board, createBoardSync, useBoard } from './board-sync'
import { ops } from './ops'
import { page, usePage, useSources, VISUAL_FRAME_PATH } from './page'
import { membersStore } from './people'
import { sessionStore } from './session-store'
import { FakeServer, FakeSocket, FakeTimers, GUEST, ME, OTHER, settle, visibleEntities } from './testing'
import { todosInternal } from './todos'
import type { BoardResponse, Op } from './types'

let server: FakeServer
let timers: FakeTimers
let sync: ReturnType<typeof createBoardSync>

const snap = () => sync.store.getState().snapshot
const gets = (needle: string) => server.requests.filter((r) => r.method === 'GET' && r.path.includes(needle))
const card = (id: string, title = id.toUpperCase()): Op => ops.createCard({ id, x: 0, y: 0, title })

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((r) => (release = r))
  return { promise, release }
}

async function openLive() {
  await sync.open()
  const ws = FakeSocket.last()
  ws.open()
  ws.receive({ type: 'subscribed', branch: server.branch.id, seq: server.seq })
  await settle()
  return ws
}

// Cards `a` (a paragraph, a Visual, a Source) and `b`, joined; Card `gone` with a block and a Connection, removed;
// a removed block on `a`.
function seed() {
  server.commit(
    [
      card('a'),
      card('b'),
      card('gone'),
      ops.addBlock({ id: 'k1', card: 'a', text: 'first', order: 'G' }),
      ops.addBlock({ id: 'k2', card: 'a', text: 'dropped', order: 'H' }),
      ops.addBlock({ id: 'v1', card: 'a', type: 'visual', text: '<p>hi</p>', title: 'Demo', order: 'V' }),
      ops.addBlock({ id: 'kg', card: 'gone', text: 'x', order: 'V' }),
      ops.createConnection({ id: 'c1', from: 'a', to: 'b' }),
      ops.createConnection({ id: 'c2', from: 'a', to: 'gone' }),
      ops.createSource({ id: 's1', title: 'Paper' }),
      ops.createSource({ id: 's2', title: 'Withdrawn' }),
      ops.attach({ id: 'at1', card: 'a', source: 's1' }),
      ops.attach({ id: 'at2', card: 'a', source: 's2' }),
      ops.remove('k2'),
      ops.remove('gone'),
      ops.remove('s2'),
    ],
    OTHER.id,
  )
}

beforeEach(() => {
  server = new FakeServer()
  timers = new FakeTimers()
  FakeSocket.all = []
  vi.stubGlobal('fetch', server.fetch)
  membersStore.setState({ members: [] })
  todosInternal.reset()
  sync = createBoardSync({
    WebSocketCtor: FakeSocket,
    setTimer: timers.set,
    clearTimer: timers.clear,
    socketUrl: () => 'ws://test/api/ws',
  })
})

afterEach(() => {
  sync.close()
  vi.unstubAllGlobals()
})

describe('a Guest', () => {
  beforeEach(() => {
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
    server.actor = GUEST
  })

  afterEach(() => {
    // Whatever happened: a Guest never asks for Changes, Members, To-dos or Suggestions, and never writes.
    expect(gets('/changes')).toEqual([])
    expect(server.requests.filter((r) => r.method !== 'GET')).toEqual([])
    expect(gets('/api/members')).toEqual([])
    expect(gets('/api/todos')).toEqual([])
    expect(gets('/api/suggestions')).toEqual([])
  })

  it('opens the Board as the server gives it: without deleted entities', async () => {
    seed()
    const ws = await openLive()
    const res = await server.fetch('/api/branches/main-id/board')
    const body = JSON.parse(await res.text()) as BoardResponse
    expect(Object.keys(body.entities).sort()).toEqual(['a', 'at1', 'b', 'c1', 'k1', 's1', 'v1'])
    expect(Object.values(body.entities).some((e) => e.deleted)).toBe(false)
    expect(body.seq).toBe(16) // still the head
    expect(snap()).toMatchObject({ status: 'live', seq: 16, readOnly: true, pending: 0, presence: [] })
    expect(snap().cards.map((c) => [c.id, c.blocks, c.sources])).toEqual([
      ['a', 2, 1],
      ['b', 0, 0],
    ])
    expect(snap().connections.map((c) => c.id)).toEqual(['c1'])
    expect(sync.page('a').blocks.map((b) => [b.id, b.type, b.title])).toEqual([
      ['k1', 'text', ''],
      ['v1', 'visual', 'Demo'],
    ])
    expect(ws.sent).toEqual([{ type: 'subscribe', branch: 'main-id', after: 16 }])
  })

  it('fetches the Board again on `refresh` and replaces what it had', async () => {
    seed()
    const ws = await openLive()
    expect(gets('/board')).toHaveLength(1)
    server.commit([card('c'), ops.remove('b'), ops.setBlockTitle('v1', 'Demo 2')], OTHER.id)
    ws.receive(server.refreshFrame())
    await settle()
    expect(gets('/board')).toHaveLength(2)
    expect(snap().cards.map((c) => c.id)).toEqual(['a', 'c'])
    expect(snap().connections).toEqual([]) // its other end went
    expect(snap().seq).toBe(19)
    expect(snap().status).toBe('live')
    expect(sync.page('a').blocks[1]).toMatchObject({ id: 'v1', title: 'Demo 2' })
  })

  it('answers a burst of `refresh` frames with at most two fetches, and ends up with the latest Board', async () => {
    seed()
    const ws = await openLive()
    const gate = deferred()
    server.boardGate = gate.promise
    for (const id of ['c', 'd', 'e', 'f', 'g']) {
      server.commit([card(id)], OTHER.id)
      ws.receive(server.refreshFrame())
    }
    await settle()
    expect(gets('/board')).toHaveLength(2) // one on its way, the rest wait
    gate.release()
    server.boardGate = null
    await settle()
    expect(gets('/board')).toHaveLength(3)
    expect(snap().cards.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    expect(snap().seq).toBe(21)
    // and the next one fetches again
    ws.receive(server.refreshFrame())
    await settle()
    expect(gets('/board')).toHaveLength(4)
  })

  it('fetches exactly once more for a `refresh` that came while a fetch was on its way', async () => {
    seed()
    const ws = await openLive()
    const gate = deferred()
    server.boardGate = gate.promise
    ws.receive(server.refreshFrame())
    await settle()
    ws.receive(server.refreshFrame())
    gate.release()
    server.boardGate = null
    await settle()
    expect(gets('/board')).toHaveLength(3)
  })

  it('keeps the identity of everything a refetch did not change', async () => {
    seed()
    const ws = await openLive()
    const before = snap()
    const pageA = sync.page('a')
    const sources = sync.sources()
    let notified = 0
    const stop = sync.store.subscribe(() => notified++)
    // nothing new at all: the very same snapshot, nobody is told
    ws.receive(server.refreshFrame())
    await settle()
    expect(snap()).toBe(before)
    expect(notified).toBe(0)
    // Card `b` renamed, Card `c` added
    server.commit([ops.setText('b', 'title', 'B2'), card('c')], OTHER.id)
    ws.receive(server.refreshFrame())
    await settle()
    stop()
    const after = snap()
    expect(after.cards.map((c) => c.id)).toEqual(['a', 'b', 'c'])
    expect(after.cards[0]).toBe(before.cards[0])
    expect(after.cards[1]).not.toBe(before.cards[1])
    expect(after.frames).toBe(before.frames)
    expect(after.connections).toBe(before.connections) // a Connection holds ids only
    expect(sync.page('a').blocks).toBe(pageA.blocks)
    expect(sync.page('a').sources).toBe(pageA.sources)
    expect(sync.sources()).toBe(sources)
  })

  it('fetches the Board again after a reconnect', async () => {
    seed()
    const ws = await openLive()
    ws.drop()
    expect(snap().status).toBe('reconnecting')
    expect(snap().cards).toHaveLength(2) // what it had stays on screen
    server.commit([card('c')], OTHER.id)
    expect(timers.delays).toEqual([1000])
    timers.fireNext()
    const next = FakeSocket.last()
    next.open()
    expect(next.sent).toEqual([{ type: 'subscribe', branch: 'main-id', after: 16 }])
    next.receive({ type: 'subscribed', branch: 'main-id', seq: 17 })
    expect(snap().status).toBe('live')
    await settle()
    expect(gets('/board')).toHaveLength(2)
    expect(snap().cards.map((c) => c.id)).toEqual(['a', 'b', 'c'])
    expect(snap().seq).toBe(17)
  })

  it('fetches after a reconnect even when the server says nothing moved, and not on the first subscription', async () => {
    seed()
    const ws = await openLive()
    expect(gets('/board')).toHaveLength(1)
    ws.drop()
    timers.fireNext()
    const next = FakeSocket.last()
    next.open()
    next.receive({ type: 'subscribed', branch: 'main-id', seq: 16 })
    await settle()
    expect(gets('/board')).toHaveLength(2)
  })

  it('has no presence and no editors, and ignores frames that are not for a Guest', async () => {
    seed()
    membersStore.setState({ members: [OTHER] })
    const ws = await openLive()
    const before = snap()
    ws.receive({ type: 'presence', branch: 'main-id', members: [OTHER.id, GUEST.id] })
    ws.receive(server.claim(OTHER.id, 'a'))
    ws.receive(server.external([card('c')])) // a `changes` frame
    server.commit([card('d')], OTHER.id)
    ws.receive(server.external([card('e')])) // one that leaves a gap
    ws.receive(server.todosFrame())
    ws.receive(server.branchesFrame())
    ws.receive(server.suggestionsFrame())
    ws.receive(server.checkpointFrame(server.checkpoint('cp')))
    await settle()
    expect(snap()).toBe(before)
    expect(snap().presence).toEqual([])
    expect(sync.page('a').editor).toBeNull()
    expect(gets('/board')).toHaveLength(1)
    // the Changes reach it the Guest way
    ws.receive(server.refreshFrame())
    await settle()
    expect(snap().cards.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(snap().presence).toEqual([])
  })

  it('ignores a `refresh` about another Branch', async () => {
    seed()
    const ws = await openLive()
    ws.receive({ type: 'refresh', branch: 'elsewhere', seq: 99 })
    await settle()
    expect(gets('/board')).toHaveLength(1)
    ws.receive({ type: 'refresh', branch: 'main', seq: 16 }) // by name is fine
    await settle()
    expect(gets('/board')).toHaveLength(2)
  })

  it('keeps the old Board when a refetch fails, shows reconnecting, and retries with the backoff', async () => {
    seed()
    const ws = await openLive()
    const cards = snap().cards
    server.commit([card('c')], OTHER.id)
    server.failBoard = 2
    ws.receive(server.refreshFrame())
    await settle()
    expect(snap().status).toBe('reconnecting')
    expect(snap().cards).toBe(cards)
    expect(snap().seq).toBe(16)
    expect(timers.delays).toEqual([1000])
    timers.fireNext()
    await settle()
    expect(snap().status).toBe('reconnecting')
    expect(timers.delays).toEqual([1000, 2000])
    timers.fireNext()
    await settle()
    expect(snap().status).toBe('live')
    expect(snap().cards.map((c) => c.id)).toEqual(['a', 'b', 'c'])
    expect(timers.pending).toEqual([])
    // the backoff starts over after a success
    server.failBoard = 1
    ws.receive(server.refreshFrame())
    await settle()
    expect(timers.delays).toEqual([1000, 2000, 1000])
  })

  it('a `refresh` while a retry is waiting fetches at once and drops the retry', async () => {
    seed()
    const ws = await openLive()
    server.failBoard = 1
    ws.receive(server.refreshFrame())
    await settle()
    expect(timers.pending).toHaveLength(1)
    ws.receive(server.refreshFrame())
    await settle()
    expect(timers.pending).toEqual([])
    expect(snap().status).toBe('live')
    expect(gets('/board')).toHaveLength(3)
  })

  it('leaves the retry to the reconnect when the socket drops meanwhile', async () => {
    seed()
    const ws = await openLive()
    server.failBoard = 1
    ws.receive(server.refreshFrame())
    await settle()
    ws.drop()
    expect(timers.pending.map((t) => t.ms)).toEqual([1000]) // only the socket's own timer
    timers.fireNext()
    const next = FakeSocket.last()
    next.open()
    next.receive({ type: 'subscribed', branch: 'main-id', seq: 16 })
    await settle()
    expect(snap().status).toBe('live')
    expect(gets('/board')).toHaveLength(3)
    expect(timers.pending).toEqual([])
  })

  it('drops a refetch that answers after the Board closed', async () => {
    seed()
    const ws = await openLive()
    const gate = deferred()
    server.boardGate = gate.promise
    ws.receive(server.refreshFrame())
    await settle()
    sync.close()
    gate.release()
    await settle()
    expect(snap().status).toBe('idle')
    expect(snap().cards).toEqual([])
    expect(timers.pending).toEqual([])
  })

  it('cannot edit, claim a Page or see Changes', async () => {
    seed()
    const ws = await openLive()
    await expect(sync.submit([ops.setBlockTitle('v1', 'x')])).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    sync.startEditing('a')
    expect(ws.sent.filter((f) => f.type === 'editing')).toEqual([])
    expect(snap().pending).toBe(0)
  })
})

describe('the fake server for a Guest', () => {
  it('refuses Changes with 403 and hands out only visible entities', async () => {
    seed()
    server.actor = GUEST
    const res = await server.fetch('/api/branches/main-id/changes?after=0')
    expect(res.status).toBe(403)
    expect(JSON.parse(await res.text())).toMatchObject({ error: { code: 'forbidden' } })
    expect(Object.keys(visibleEntities(server.entities)).sort()).toEqual(['a', 'at1', 'b', 'c1', 'k1', 's1', 'v1'])
    expect(server.refreshFrame()).toEqual({ type: 'refresh', branch: 'main-id', seq: 16 })
    server.actor = ME
    const full = JSON.parse(await (await server.fetch('/api/branches/main-id/board')).text()) as BoardResponse
    expect(Object.keys(full.entities)).toHaveLength(13)
  })
})

describe('a Member is unaffected', () => {
  beforeEach(() => {
    sessionStore.setState({ status: 'signed_in', member: ME }, true)
  })

  it('ignores a stray `refresh` frame and still catches up through Changes', async () => {
    seed()
    const ws = await openLive()
    const before = snap()
    server.commit([card('c')], OTHER.id) // frame never delivered
    ws.receive(server.refreshFrame())
    await settle()
    expect(snap()).toBe(before)
    expect(gets('/board')).toHaveLength(1)
    expect(gets('/changes')).toEqual([])
    ws.receive(server.external([card('d')])) // leaves a gap
    await settle()
    expect(gets('/changes').map((r) => r.path)).toEqual(['/api/branches/main-id/changes?after=16'])
    expect(gets('/board')).toHaveLength(1)
    expect(snap().cards.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(snap().seq).toBe(18)
  })

  it('gets the whole Board, deleted entities included, presence and editors as before', async () => {
    seed()
    membersStore.setState({ members: [ME, OTHER] })
    const ws = await openLive()
    ws.receive({ type: 'presence', branch: 'main-id', members: [OTHER.id] })
    ws.receive(server.claim(OTHER.id, 'a'))
    expect(snap().presence).toEqual([OTHER])
    expect(sync.page('a').editor?.memberId).toBe(OTHER.id)
    // a deleted Card can be brought back: it is still in the store
    await sync.submit([ops.restore('gone')])
    expect(snap().cards.map((c) => c.id)).toEqual(['a', 'b', 'gone'])
    expect(snap().connections.map((c) => c.id)).toEqual(['c1', 'c2'])
  })

  it('does not fetch the Board again after a reconnect', async () => {
    seed()
    const ws = await openLive()
    ws.drop()
    timers.fireNext()
    const next = FakeSocket.last()
    next.open()
    next.receive({ type: 'subscribed', branch: 'main-id', seq: 16 })
    await settle()
    expect(gets('/board')).toHaveLength(1)
  })
})

describe('the hooks, for a Guest', () => {
  beforeEach(() => {
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
    server.actor = GUEST
    vi.stubGlobal('WebSocket', FakeSocket)
  })

  afterEach(() => {
    board.close()
  })

  it('usePage, useSources and useBoard work read-only and follow `refresh`', async () => {
    seed()
    expect(VISUAL_FRAME_PATH).toBe('/visual-frame')
    const hooks = renderHook(() => ({ board: useBoard(), page: usePage('a'), none: usePage('gone'), sources: useSources() }))
    await act(async () => {
      await board.open()
      FakeSocket.last().open()
      FakeSocket.last().receive({ type: 'subscribed', branch: 'main-id', seq: 16 })
      await settle()
    })
    const first = hooks.result.current
    expect(first.board).toMatchObject({ status: 'live', readOnly: true, presence: [] })
    expect(first.page.card?.id).toBe('a')
    expect(first.page.blocks.map((b) => [b.id, b.type, b.title, b.text])).toEqual([
      ['k1', 'text', '', 'first'],
      ['v1', 'visual', 'Demo', '<p>hi</p>'],
    ])
    expect(first.page.sources.map((s) => s.id)).toEqual(['s1'])
    expect(first.page.connections.map((c) => c.other.id)).toEqual(['b'])
    expect(first.page.editor).toBeNull()
    expect(first.none.card).toBeNull()
    expect(first.sources.map((s) => s.id)).toEqual(['s1'])
    page.startEditing('a')
    expect(FakeSocket.last().sent.filter((f) => f.type === 'editing')).toEqual([])
    await expect(board.submit([ops.setBlockText('k1', 'x')])).rejects.toMatchObject({ status: 403 })
    // an edit elsewhere does not touch this Page; an edit here replaces only what changed
    await act(async () => {
      server.commit([card('z')], OTHER.id)
      FakeSocket.last().receive(server.refreshFrame())
      await settle()
    })
    expect(hooks.result.current.board.cards.map((c) => c.id)).toEqual(['a', 'b', 'z'])
    expect(hooks.result.current.page).toBe(first.page)
    await act(async () => {
      server.commit([ops.setBlockText('v1', '<p>new</p>')], OTHER.id)
      FakeSocket.last().receive(server.refreshFrame())
      await settle()
    })
    const last = hooks.result.current.page
    expect(last.blocks[1]).toMatchObject({ id: 'v1', text: '<p>new</p>' })
    expect(last.blocks[0]).toBe(first.page.blocks[0])
    expect(last.sources).toBe(first.page.sources)
    expect(gets('/changes')).toEqual([])
    hooks.unmount()
  })
})
