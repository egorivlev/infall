import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBoardSync } from './board-sync'
import { branchesStore } from './branches-store'
import { createGraph, extendGraph, GRAPH_GAP_MS } from './graph'
import { activityKey, layoutGraph } from './graph-layout'
import { ops } from './ops'
import { membersStore } from './people'
import { sessionStore } from './session-store'
import { FakeServer, FakeSocket, FakeTimers, GUEST, ME, OTHER, settle } from './testing'
import type { Change, GraphResponse, Op } from './types'

const MIN = 60_000
let server: FakeServer
let timers: FakeTimers
let sync: ReturnType<typeof createBoardSync>
let graph: ReturnType<typeof createGraph>
let focus: EventTarget

const snap = () => graph.store.getState().snapshot
const graphGets = () => server.requests.filter((r) => r.path.startsWith('/api/graph'))
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
  focus = new EventTarget()
  graph = createGraph(sync, { focusTarget: focus })
})

afterEach(() => {
  graph.close()
  sync.close()
  vi.unstubAllGlobals()
})

describe('extendGraph', () => {
  const log = (list: [string, number][], start = 0): Change[] =>
    list.map(([author, at], i) => ({ id: `c${start + i}`, author, at, op: card(`e${start + i}`), origin: 'Edit' }))
  const base: GraphResponse = {
    branches: [
      {
        id: 'b',
        name: 'b',
        seq: 2,
        checkpoints: [],
        activities: [{ kind: 'edit', author: 'me', from_seq: 0, to_seq: 2, started_at: 0, ended_at: 1000 }],
      },
    ],
  }
  it('goes on with the last Activity when the server would, and starts new ones otherwise', () => {
    const next = extendGraph(base, 'b', 2, log([['me', 2000], ['me', 3000], ['other', 3000], ['other', 3000 + 11 * MIN]], 2))!
    expect(next.branches[0]!.seq).toBe(6)
    expect(next.branches[0]!.activities.map((a) => [a.author, a.from_seq, a.to_seq, a.ended_at])).toEqual([
      ['me', 0, 4, 3000],
      ['other', 4, 5, 3000],
      ['other', 5, 6, 3000 + 11 * MIN],
    ])
    expect(base.branches[0]!.seq).toBe(2) // not changed in place
  })
  it('does not go on past a Checkpoint at the head', () => {
    const withCp: GraphResponse = { branches: [{ ...base.branches[0]!, checkpoints: [{ name: 'x', seq: 2, author: 'me', at: 0 }] }] }
    const next = extendGraph(withCp, 'b', 2, log([['me', 1500]], 2))!
    expect(next.branches[0]!.activities.map((a) => [a.from_seq, a.to_seq])).toEqual([
      [0, 2],
      [2, 3],
    ])
  })
  it('skips what it has, refuses a gap and an unknown Branch', () => {
    expect(extendGraph(base, 'b', 0, log([['me', 0], ['me', 0]]))).toBe(base)
    expect(extendGraph(base, 'b', 1, log([['me', 0], ['me', 1000], ['me', 1000]], 1))!.branches[0]!.seq).toBe(4)
    expect(extendGraph(base, 'b', 3, log([['me', 0]], 3))).toBeNull()
    expect(extendGraph(base, 'nope', 2, log([['me', 0]], 2))).toBeNull()
  })
  it('gives what the server gives, Merges and Restores included', () => {
    server.now = 0
    server.commit([card('a', 'A')], ME.id)
    const before = server.graph()
    server.now = 1000
    const more = [
      ...server.commit([card('b')], ME.id),
      ...server.commit([card('c'), card('d')], ME.id, undefined, { Merge: { batch: 'm', source: { branch: 'x', seq: 3 } } }),
      ...server.commit([ops.remove('c')], OTHER.id, undefined, { Restore: { batch: 'r', to_seq: 3 } }),
      ...server.commit([card('e')], OTHER.id),
    ]
    expect(extendGraph(before, 'main-id', 1, more)).toEqual(server.graph())
  })
})

describe('graph.open', () => {
  it('loads the graph with the gap of History and lays it out', async () => {
    server.commit([card('a', 'A')], ME.id)
    server.fork('idea', { branch: 'main-id', seq: 1 })
    await graph.open()
    expect(graphGets().map((r) => r.path)).toEqual([`/api/graph?gap_ms=${GRAPH_GAP_MS}`])
    expect(GRAPH_GAP_MS).toBe(600_000)
    expect(snap().status).toBe('ready')
    expect(snap().graph).toEqual(server.graph())
    expect(snap().layout).toEqual(layoutGraph(server.graph()))
  })
  it('is refused locally for a Guest', async () => {
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
    await expect(graph.open()).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    expect(server.requests).toEqual([])
    expect(snap().status).toBe('idle')
  })
  it('ends in error when the first load fails, and keeps the graph when a later one does', async () => {
    server.failGraph = 1
    await expect(graph.open()).rejects.toMatchObject({ status: 500 })
    expect(snap()).toMatchObject({ status: 'error', graph: null })
    await graph.open()
    expect(snap().status).toBe('ready')
    const shown = snap().graph
    server.failGraph = 1
    await graph.refresh()
    expect(snap()).toMatchObject({ status: 'ready', error: 'x' })
    expect(snap().graph).toBe(shown)
  })
  it('fetches again when opened again', async () => {
    await graph.open()
    await graph.open()
    expect(graphGets()).toHaveLength(2)
  })
})

describe('staying current', () => {
  it('fetches again on the branches frame: a new Branch or a Merge', async () => {
    const ws = await openLive()
    await graph.open()
    server.fork('idea', { branch: 'main-id', seq: 0 })
    ws.receive(server.branchesFrame())
    await settle()
    expect(graphGets()).toHaveLength(2)
    expect(snap().graph!.branches.map((b) => b.name)).toEqual(['main', 'idea'])
  })
  it('adds new dots of the open Branch as they happen, without a request', async () => {
    server.now = 0
    server.commit([card('a', 'A')], ME.id)
    const ws = await openLive()
    await graph.open()
    const before = server.requests.length
    server.now = 1000
    ws.receive(server.external([card('b', 'B')], ME.id))
    server.now = 2000
    ws.receive(server.external([card('c', 'C')], OTHER.id))
    expect(server.requests.length).toBe(before)
    expect(snap().graph).toEqual(server.graph())
    expect(snap().layout!.rows.map((r) => r.key)).toEqual(layoutGraph(server.graph()).rows.map((r) => r.key))
  })
  it('follows the Board when it catches up over HTTP, and fetches again when it had to reload', async () => {
    const ws = await openLive()
    await graph.open()
    server.commit([card('a', 'A')], OTHER.id) // frame lost
    ws.receive(server.external([card('b', 'B')], OTHER.id)) // the Board reads the missed Changes: both arrive
    await settle()
    expect(graphGets()).toHaveLength(1)
    expect(snap().graph).toEqual(server.graph())
    server.commit([card('c', 'C'), card('d', 'D')], OTHER.id) // frames lost
    // A frame that fits by number but cannot apply makes the Board reload whole: its Changes are never seen.
    const bad: Change = { id: 'bad', author: 'other', at: 0, op: ops.remove('ghost'), origin: 'Edit' }
    ws.receive({ type: 'changes', branch: 'main-id', seq: 3, changes: [bad] })
    await settle()
    expect(graphGets()).toHaveLength(2)
    expect(snap().graph).toEqual(server.graph())
  })
  it('does not follow other Branches live: their dots come with focus', async () => {
    server.fork('idea', { branch: 'main-id', seq: 0 })
    await openLive()
    await graph.open()
    server.commit([card('x', 'X')], OTHER.id, 'idea')
    await settle()
    expect(snap().graph!.branches[1]!.seq).toBe(0)
    focus.dispatchEvent(new Event('focus'))
    await settle()
    expect(snap().graph!.branches[1]!.seq).toBe(1)
  })
  it('fetches again on a Checkpoint of the open Branch, which splits its Activity', async () => {
    server.commit([card('a', 'A'), card('b', 'B')], ME.id)
    const ws = await openLive()
    await graph.open()
    ws.receive(server.checkpointFrame(server.checkpoint('mid', 1, OTHER.id)))
    await settle()
    expect(snap().graph!.branches[0]!.activities.map((a) => [a.from_seq, a.to_seq])).toEqual([
      [0, 1],
      [1, 2],
    ])
  })
  it('fetches again after the socket reconnects', async () => {
    const ws = await openLive()
    await graph.open()
    ws.drop()
    timers.fireNext()
    const next = FakeSocket.last()
    next.open()
    next.receive({ type: 'subscribed', branch: 'main-id', seq: 0 })
    await settle()
    expect(graphGets().length).toBeGreaterThanOrEqual(2)
  })
  it('asks once at a time: what is asked meanwhile is one more request after', async () => {
    await graph.open()
    let release!: () => void
    server.graphGate = new Promise<void>((r) => (release = r))
    const a = graph.refresh()
    const b = graph.refresh()
    const c = graph.refresh()
    await settle()
    expect(graphGets()).toHaveLength(2)
    server.graphGate = null
    release()
    await Promise.all([a, b, c])
    await settle()
    expect(graphGets()).toHaveLength(3)
  })
  it('keeps dots that arrived while a fetch was on its way', async () => {
    const ws = await openLive()
    await graph.open()
    let release!: () => void
    server.graphGate = new Promise<void>((r) => (release = r))
    const pending = graph.refresh()
    await settle()
    server.graphGate = null
    ws.receive(server.external([card('a', 'A')], OTHER.id))
    expect(snap().graph!.branches[0]!.seq).toBe(1)
    // The answer was made before that Change; it does not take the dot away.
    server.log.pop()
    release()
    await pending
    expect(snap().graph!.branches[0]!.seq).toBe(1)
  })
  it('stops listening on close() and when the session ends', async () => {
    const ws = await openLive()
    await graph.open()
    graph.close()
    expect(snap()).toEqual({ status: 'idle', graph: null, layout: null })
    focus.dispatchEvent(new Event('focus'))
    ws.receive(server.branchesFrame())
    await settle()
    expect(graphGets()).toHaveLength(1)
    await graph.open()
    sessionStore.setState({ status: 'signed_out' }, true)
    expect(snap().status).toBe('idle')
  })
})

describe('graph actions', () => {
  it('adds a Checkpoint to any Branch and fetches the graph again; the open Board hears of it', async () => {
    server.commit([card('a', 'A'), card('b', 'B')], ME.id)
    server.fork('idea', { branch: 'main-id', seq: 2 })
    await openLive()
    await graph.open()
    const cp = await graph.addCheckpoint('main-id', 'here', 1)
    expect(cp).toMatchObject({ name: 'here', moment: { branch: 'main-id', seq: 1 } })
    expect(server.requests.find((r) => r.method === 'POST')).toMatchObject({
      path: '/api/branches/main-id/checkpoints',
      body: { name: 'here', seq: 1 },
    })
    expect(sync.store.getState().snapshot.branch?.checkpoints).toBe(1)
    expect(snap().graph!.branches[0]!.activities).toHaveLength(2)
    await graph.addCheckpoint('idea-id', 'start', 0)
    expect(snap().graph!.branches[1]!.checkpoints.map((c) => c.name)).toEqual(['start'])
    await expect(graph.addCheckpoint('main-id', 'here', 2)).rejects.toMatchObject({ status: 409, code: 'name_taken' })
  })
  it('works out the words of rows on screen, and every Change of one', async () => {
    server.now = 0
    server.commit([card('a', 'A')], ME.id)
    server.now = 11 * MIN
    server.commit([ops.setText('a', 'title', 'A2')], OTHER.id)
    await graph.open()
    const layout = snap().layout!
    await graph.need([0, 1, 2]) // the start row has no words
    const top = layout.rows[0]!
    expect(graph.text.lines(top.key)).toEqual(['Renamed Card A → A2'])
    expect(graph.text.lines(activityKey('main-id', snap().graph!.branches[0]!.activities[0]!))).toEqual(['Added Card A'])
    expect(await graph.changesOf(0)).toMatchObject([{ author: OTHER.id, line: 'Renamed Card A → A2' }])
    expect(await graph.changesOf(2)).toEqual([])
  })
})
