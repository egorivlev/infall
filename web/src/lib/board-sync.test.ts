import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBoardSync } from './board-sync'
import { ApiError } from './http'
import { ops } from './ops'
import { membersStore } from './people'
import { sessionStore } from './session-store'
import { FakeServer, FakeSocket, FakeTimers, ME, OTHER, settle } from './testing'
import type { Op } from './types'

let server: FakeServer
let timers: FakeTimers
let sync: ReturnType<typeof createBoardSync>

const snap = () => sync.store.getState().snapshot
const posts = () => server.requests.filter((r) => r.method === 'POST')
const gets = (needle: string) => server.requests.filter((r) => r.method === 'GET' && r.path.includes(needle))

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

const card = (id: string): Op => ops.createCard({ id, x: 0, y: 0 })

beforeEach(() => {
  server = new FakeServer()
  timers = new FakeTimers()
  FakeSocket.all = []
  vi.stubGlobal('fetch', server.fetch)
  sessionStore.setState({ status: 'signed_in', member: ME }, true)
  membersStore.setState({ members: [] })
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

describe('open', () => {
  it('loads the Board and subscribes from the current seq', async () => {
    server.commit([card('a')], OTHER.id)
    await sync.open()
    expect(snap().status).toBe('loading')
    expect(snap().cards.map((c) => c.id)).toEqual(['a'])
    expect(snap().seq).toBe(1)
    expect(snap().branch?.name).toBe('main')
    const ws = FakeSocket.last()
    expect(ws.url).toBe('ws://test/api/ws')
    expect(ws.sent).toEqual([])
    ws.open()
    expect(ws.sent).toEqual([{ type: 'subscribe', branch: 'main-id', after: 1 }])
    ws.receive({ type: 'subscribed', branch: 'main-id', seq: 1 })
    expect(snap().status).toBe('live')
  })
  it('goes to error and rejects when the Board cannot be loaded', async () => {
    server.branch = { id: 'other', name: 'other', seq: 0, checkpoints: 0 }
    await expect(sync.open('main')).rejects.toMatchObject({ code: 'not_found' })
    expect(snap().status).toBe('error')
    expect(snap().error).toBeTruthy()
  })
  it('falls back to the name as the id when listing Branches is forbidden', async () => {
    const inner = server.fetch
    vi.stubGlobal('fetch', (path: string, init?: RequestInit) =>
      path === '/api/branches'
        ? Promise.resolve({
            ok: false,
            status: 403,
            text: async () => JSON.stringify({ error: { code: 'forbidden', message: 'x', detail: null } }),
          } as Response)
        : inner(path, init),
    )
    server.branch = { id: 'main', name: 'main', seq: 0, checkpoints: 0 }
    await sync.open()
    expect(snap().cards).toEqual([])
    expect(server.requests.some((r) => r.path === '/api/branches/main/board')).toBe(true)
  })
  it('resolves presence through the members store and drops unknown ids', async () => {
    const ws = await openLive()
    ws.receive({ type: 'presence', branch: 'main-id', members: ['me', 'other', 'ghost'] })
    await settle() // the unknown ids trigger one members reload
    expect(snap().presence).toEqual([ME, OTHER])
    expect(gets('/api/members')).toHaveLength(1)
    ws.receive({ type: 'presence', branch: 'main-id', members: ['me', 'ghost'] })
    await settle()
    expect(snap().presence).toEqual([ME])
    expect(gets('/api/members')).toHaveLength(1)
  })
})

describe('submit', () => {
  it('shows an optimistic change at once and confirms it', async () => {
    await openLive()
    const gate = deferred()
    server.gate = gate.promise
    const done = sync.submit([card('a')])
    expect(snap().cards.map((c) => c.id)).toEqual(['a'])
    expect(snap().pending).toBe(1)
    expect(snap().seq).toBe(0)
    gate.release()
    await done
    expect(snap().pending).toBe(0)
    expect(snap().seq).toBe(1)
    expect(snap().cards).toHaveLength(1)
    expect(posts()[0]?.body).toEqual({ ops: [card('a')] })
  })

  it('does not double-apply when the socket echo arrives before the response', async () => {
    const ws = await openLive()
    const respond = deferred()
    server.responseGate = respond.promise
    const done = sync.submit([card('a'), ops.setText('a', 'title', 'mine')])
    await settle()
    const echo = server.lastPostFrame
    if (!echo) throw new Error('post did not reach the server')
    ws.receive(echo)
    expect(snap().seq).toBe(2)
    expect(snap().pending).toBe(0)
    // someone else edits the title before our response arrives
    ws.receive(server.external([ops.setText('a', 'title', 'theirs')]))
    expect(snap().cards[0]?.title).toBe('theirs')
    respond.release()
    await done
    expect(snap().cards[0]?.title).toBe('theirs')
    expect(snap().seq).toBe(3)
    expect(gets('/changes')).toHaveLength(0)
    expect(gets('/board')).toHaveLength(1)
  })

  it('applies the response when it arrives first, then ignores the echo', async () => {
    const ws = await openLive()
    await sync.submit([card('a')])
    const before = snap()
    ws.receive(server.lastPostFrame!)
    expect(snap()).toBe(before)
  })

  it('rejects locally, with no request, an op the current view refuses', async () => {
    await openLive()
    await expect(sync.submit([ops.setStatus('nope', 'idea')])).rejects.toMatchObject({
      status: 409,
      code: 'rejected',
    })
    expect(posts()).toHaveLength(0)
    expect(snap().pending).toBe(0)
  })

  it('rolls back and rejects when the server refuses', async () => {
    await openLive()
    server.failNext = { status: 409, code: 'rejected' }
    const done = sync.submit([card('a')])
    expect(snap().cards).toHaveLength(1)
    const err = await done.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 409, code: 'rejected' })
    expect(snap().cards).toHaveLength(0)
    expect(snap().pending).toBe(0)
  })

  it('also rolls back on a network failure', async () => {
    await openLive()
    const inner = server.fetch
    vi.stubGlobal('fetch', (path: string, init?: RequestInit) =>
      init?.method === 'POST' ? Promise.reject(new TypeError('offline')) : inner(path, init),
    )
    await expect(sync.submit([card('a')])).rejects.toMatchObject({ status: 0, code: 'network' })
    expect(snap().cards).toHaveLength(0)
  })

  it('drops later batches that depended on a failed one', async () => {
    await openLive()
    const gate = deferred()
    server.gate = gate.promise
    server.failNext = { status: 500, code: 'internal' }
    const first = sync.submit([card('a')])
    const second = sync.submit([ops.setText('a', 'title', 'x')])
    const e1 = first.catch((e: unknown) => e)
    const e2 = second.catch((e: unknown) => e)
    gate.release()
    expect(await e1).toMatchObject({ code: 'internal' })
    expect(await e2).toMatchObject({ code: 'rejected' })
    expect(posts()).toHaveLength(1)
    expect(snap().cards).toHaveLength(0)
  })

  it('sends queued batches one at a time, in order', async () => {
    await openLive()
    const gate = deferred()
    server.gate = gate.promise
    const a = sync.submit([card('a')])
    const b = sync.submit([card('b')])
    const c = sync.submit([card('c')])
    await settle()
    expect(posts()).toHaveLength(1)
    expect(snap().pending).toBe(3)
    gate.release()
    await Promise.all([a, b, c])
    expect(posts().map((p) => (p.body as { ops: Op[] }).ops)).toEqual([[card('a')], [card('b')], [card('c')]])
    expect(snap().seq).toBe(3)
    expect(snap().pending).toBe(0)
  })

  it('merges a remote change that arrives while a local batch is pending', async () => {
    const ws = await openLive()
    await sync.submit([card('a')])
    const gate = deferred()
    server.gate = gate.promise
    const mine = sync.submit([ops.setText('a', 'title', 'mine')])
    await settle()
    ws.receive(server.external([ops.setText('a', 'title', 'theirs'), card('z')])) // seq 2, 3
    expect(snap().seq).toBe(3)
    expect(snap().cards.map((c) => c.id)).toEqual(['a', 'z'])
    expect(snap().cards[0]?.title).toBe('mine') // pending overlay on top of server truth
    gate.release()
    await mine
    expect(snap().cards[0]?.title).toBe('mine') // server order: ours was last
    expect(snap().seq).toBe(4)
    expect(snap().pending).toBe(0)
    // final state equals the server's
    expect(snap().cards.map((c) => [c.id, c.title])).toEqual([
      ['a', 'mine'],
      ['z', ''],
    ])
  })

  it('rejects a queued batch whose target a remote change removed', async () => {
    const ws = await openLive()
    await sync.submit([card('a')])
    const gate = deferred()
    server.gate = gate.promise
    const first = sync.submit([card('b')])
    const second = sync.submit([ops.setText('a', 'title', 'late')])
    const e2 = second.catch((e: unknown) => e)
    await settle()
    ws.receive(server.external([ops.remove('a')]))
    expect(await e2).toMatchObject({ code: 'rejected' })
    gate.release()
    await first
    expect(snap().cards.map((c) => c.id)).toEqual(['b'])
  })

  it('rejects submit for a Guest without sending anything', async () => {
    sessionStore.setState({ status: 'signed_in', member: { ...ME, role: 'guest' } }, true)
    await openLive()
    expect(snap().readOnly).toBe(true)
    await expect(sync.submit([card('a')])).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    expect(posts()).toHaveLength(0)
    expect(snap().cards).toHaveLength(0)
  })

  it('rejects when the Board is not open', async () => {
    await expect(sync.submit([card('a')])).rejects.toMatchObject({ code: 'board_not_open' })
  })

  it('rejects pending batches on close', async () => {
    await openLive()
    server.gate = new Promise(() => {})
    const p = sync.submit([card('a')]).catch((e: unknown) => e)
    sync.close()
    expect(await p).toMatchObject({ code: 'closed' })
    expect(snap().status).toBe('idle')
    expect(snap().cards).toEqual([])
  })
})

describe('live updates', () => {
  it('applies a contiguous frame', async () => {
    const ws = await openLive()
    ws.receive(server.external([card('a')]))
    expect(snap().cards.map((c) => c.id)).toEqual(['a'])
    expect(snap().seq).toBe(1)
  })

  it('fetches the missing Changes when a frame leaves a gap', async () => {
    const ws = await openLive()
    server.commit([card('a')], OTHER.id) // frame never delivered
    ws.receive(server.external([card('b')]))
    await settle()
    expect(gets('/changes?after=0')).toHaveLength(1)
    expect(snap().cards.map((c) => c.id)).toEqual(['a', 'b'])
    expect(snap().seq).toBe(2)
  })

  it('reloads the whole Board when the catch-up fetch fails', async () => {
    const ws = await openLive()
    server.failChanges = true
    server.commit([card('a')], OTHER.id)
    ws.receive(server.external([card('b')]))
    await settle()
    expect(gets('/changes')).toHaveLength(1)
    expect(gets('/board')).toHaveLength(2)
    expect(snap().cards.map((c) => c.id)).toEqual(['a', 'b'])
    expect(snap().seq).toBe(2)
  })

  it('ignores a frame that is already applied', async () => {
    const ws = await openLive()
    const frame = server.external([card('a')])
    ws.receive(frame)
    const before = snap()
    ws.receive(frame)
    await settle()
    expect(snap()).toBe(before)
    expect(gets('/changes')).toHaveLength(0)
  })

  it('applies only the new tail of an overlapping frame', async () => {
    const ws = await openLive()
    const first = server.external([card('a')])
    ws.receive(first)
    const both = server.external([card('b')])
    if (both.type !== 'changes') throw new Error('x')
    ws.receive({ ...both, changes: [...(first.type === 'changes' ? first.changes : []), ...both.changes] })
    expect(snap().cards.map((c) => c.id)).toEqual(['a', 'b'])
    expect(snap().seq).toBe(2)
  })
})

describe('reconnecting', () => {
  it('goes reconnecting, backs off, and resubscribes with the current seq', async () => {
    const ws = await openLive()
    ws.receive(server.external([card('a')]))
    ws.receive({ type: 'presence', branch: 'main-id', members: ['me'] })
    ws.drop()
    expect(snap().status).toBe('reconnecting')
    expect(snap().presence).toEqual([])
    expect(timers.delays).toEqual([1000])

    timers.fireNext()
    const second = FakeSocket.last()
    expect(second).not.toBe(ws)
    second.drop() // never connected
    expect(timers.delays).toEqual([1000, 2000])

    timers.fireNext()
    const third = FakeSocket.last()
    third.open()
    expect(third.sent).toEqual([{ type: 'subscribe', branch: 'main-id', after: 1 }])
    third.receive({ type: 'subscribed', branch: 'main-id', seq: 1 })
    expect(snap().status).toBe('live')

    third.drop() // backoff restarted after a successful subscribe
    expect(timers.delays).toEqual([1000, 2000, 1000])
  })

  it('caps the backoff at 15 s', async () => {
    await openLive()
    FakeSocket.last().drop()
    for (let i = 0; i < 8; i++) {
      timers.fireNext()
      FakeSocket.last().drop()
    }
    expect(timers.delays).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000, 15000, 15000])
  })

  it('catches up through the resubscribe frame', async () => {
    const ws = await openLive()
    ws.drop()
    server.commit([card('a')], OTHER.id)
    timers.fireNext()
    const next = FakeSocket.last()
    next.open()
    next.receive({ type: 'subscribed', branch: 'main-id', seq: 1 })
    next.receive(server.frameFor(server.log.slice(0)))
    expect(snap().cards.map((c) => c.id)).toEqual(['a'])
    expect(snap().status).toBe('live')
  })

  it('close cancels the reconnect timer and the socket', async () => {
    const ws = await openLive()
    ws.drop()
    sync.close()
    expect(timers.pending).toHaveLength(0)
    const live = await openLive()
    sync.close()
    expect(live.closed).toBe(true)
  })
})

describe('snapshot identity', () => {
  it('is stable when an irrelevant store update happens', async () => {
    const ws = await openLive()
    await sync.submit([card('a')])
    ws.receive({ type: 'presence', branch: 'main-id', members: ['me'] })
    const before = snap()
    membersStore.setState({ members: [OTHER] }) // does not change who is present
    sessionStore.setState({ status: 'signed_in', member: { ...ME } }, true) // same role, new object
    expect(snap().cards).toBe(before.cards)
    expect(snap().frames).toBe(before.frames)
    expect(snap().connections).toBe(before.connections)
  })

  it('keeps untouched arrays when only one kind changes', async () => {
    const ws = await openLive()
    await sync.submit([card('a'), ops.createFrame({ id: 'f', x: 0, y: 0, w: 5, h: 5 })])
    const before = snap()
    ws.receive(server.external([ops.setText('a', 'title', 'x')]))
    expect(snap().cards).not.toBe(before.cards)
    expect(snap().frames).toBe(before.frames)
  })

  it('does not notify subscribers for a duplicate frame', async () => {
    const ws = await openLive()
    const frame = server.external([card('a')])
    ws.receive(frame)
    const listener = vi.fn()
    const off = sync.store.subscribe(listener)
    ws.receive(frame)
    off()
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('session end', () => {
  it('closes the Board when the session turns signed_out', async () => {
    const ws = await openLive()
    sessionStore.setState({ status: 'signed_out' }, true)
    expect(snap().status).toBe('idle')
    expect(ws.closed).toBe(true)
  })
})
