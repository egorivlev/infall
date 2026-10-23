import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { replay } from './activities'
import { createBoardSync } from './board-sync'
import { branchesStore } from './branches-store'
import { createHistory, previewAt } from './history'
import { ops } from './ops'
import { membersStore } from './people'
import { sessionStore } from './session-store'
import { FakeServer, FakeSocket, FakeTimers, GUEST, ME, OTHER, restoreOps, settle } from './testing'
import type { Change, Op } from './types'

let server: FakeServer
let timers: FakeTimers
let sync: ReturnType<typeof createBoardSync>
let history: ReturnType<typeof createHistory>

const board = () => sync.store.getState().snapshot
const snap = () => history.store.getState().snapshot
const gets = (needle: string) => server.requests.filter((r) => r.method === 'GET' && r.path.includes(needle))
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
  history = createHistory(sync)
})

afterEach(() => {
  sync.close()
  vi.unstubAllGlobals()
})

describe('previewAt', () => {
  const log = (list: Op[]): Change[] => list.map((op, i) => ({ id: `c${i}`, author: 'me', at: 100 + i, op, origin: 'Edit' }))
  const changes = log([card('a', 'A'), card('b', 'B'), ops.setText('a', 'title', 'A2'), ops.remove('b')])

  it('replays the first seq Changes on the base Board', () => {
    expect(previewAt({}, changes, 0)).toMatchObject({ seq: 0, at: null, cards: [] })
    expect(previewAt({}, changes, 2).cards.map((c) => c.title)).toEqual(['A', 'B'])
    expect(previewAt({}, changes, 3).cards.map((c) => c.title)).toEqual(['A2', 'B'])
    expect(previewAt({}, changes, 4).cards.map((c) => c.title)).toEqual(['A2'])
  })
  it('gives the time of the last Change before the moment', () => {
    expect(previewAt({}, changes, 1).at).toBe(100)
    expect(previewAt({}, changes, 4).at).toBe(103)
  })
  it('clamps the moment to the log', () => {
    expect(previewAt({}, changes, 99).seq).toBe(4)
    expect(previewAt({}, changes, -3).seq).toBe(0)
    expect(previewAt({}, changes, 2.9).seq).toBe(2)
  })
  it('starts from the base Board of a forked Branch, Frames and Connections included', () => {
    const base = replay({}, [
      card('p', 'Parent'),
      card('q', 'Q'),
      ops.createFrame({ id: 'f', x: 0, y: 0, w: 5, h: 5 }),
      ops.createConnection({ id: 'k', from: 'p', to: 'q' }),
    ])
    const forked = log([ops.remove('q')])
    const zero = previewAt(base, forked, 0)
    expect(zero.cards.map((c) => c.id)).toEqual(['p', 'q'])
    expect(zero.frames).toHaveLength(1)
    expect(zero.connections).toHaveLength(1)
    expect(previewAt(base, forked, 1).connections).toEqual([]) // a Connection to a removed Card is not shown
  })
  it('keeps the identity of items that did not change between two moments', () => {
    const two = previewAt({}, changes, 2)
    const three = previewAt({}, changes, 3, two)
    expect(three.cards[1]).toBe(two.cards[1]) // B untouched
    expect(three.cards[0]).not.toBe(two.cards[0]) // A renamed
    expect(three.frames).toBe(two.frames)
    const again = previewAt({}, changes, 3, three)
    expect(again.cards).toBe(three.cards)
  })
})

describe('restoreOps (fake server)', () => {
  it('turns the current Board into the target with deletes, undeletes and sets', () => {
    const target = replay({}, [card('a', 'A'), card('b', 'B'), ops.remove('b')])
    const current = replay(target, [ops.setText('a', 'title', 'Z'), ops.setStatus('a', 'reading'), ops.restore('b'), card('c')])
    const after = replay(current, restoreOps(current, target))
    expect(after.a).toEqual(target.a)
    expect(after.b).toEqual(target.b)
    expect(after.c?.deleted).toBe(true)
  })
})

describe('history.open', () => {
  it('needs an open Board', async () => {
    await expect(history.open()).rejects.toMatchObject({ status: 400, code: 'board_not_open' })
    expect(snap().status).toBe('idle')
  })
  it('loads Changes, Checkpoints and the seq-0 Board, and groups Activities', async () => {
    server.commit([card('a', 'A')], ME.id)
    server.checkpoint('first')
    server.commit([card('b', 'B')], OTHER.id)
    server.checkpoint('start', 0)
    await openLive()
    const opening = history.open()
    expect(snap().status).toBe('loading')
    await opening
    expect(gets('/changes?after=0')).toHaveLength(1)
    expect(gets('/checkpoints')).toHaveLength(1)
    expect(gets('/board?at=0')).toHaveLength(1)
    const s = snap()
    expect(s.status).toBe('ready')
    expect(s.head).toBe(2)
    expect(s.branch).toBe(board().branch)
    expect(s.checkpoints.map((c) => c.name)).toEqual(['start', 'first'])
    expect(s.activities.map((a) => [a.author, a.fromSeq, a.toSeq, a.lines])).toEqual([
      ['me', 0, 1, ['Added Card A']],
      ['other', 1, 2, ['Added Card B']],
    ])
    expect(s.activities[0]!.checkpoints.map((c) => c.name)).toEqual(['first'])
    expect(s.preview).toBeNull()
  })
  it('is idempotent while open and returns the same snapshot object between changes', async () => {
    await openLive()
    await Promise.all([history.open(), history.open()])
    const before = snap()
    await history.open()
    expect(gets('/changes?after=0')).toHaveLength(1)
    expect(snap()).toBe(before)
  })
  it('goes to error and rejects when loading fails, and can be opened again', async () => {
    await openLive()
    server.failChanges = true
    await expect(history.open()).rejects.toMatchObject({ status: 500 })
    expect(snap().status).toBe('error')
    expect(snap().error).toBeTruthy()
    server.failChanges = false
    await history.open()
    expect(snap().status).toBe('ready')
    expect(snap().error).toBeUndefined()
  })
  it('reads a forked Branch from its own seq 0', async () => {
    server.commit([card('a', 'A')], ME.id)
    server.fork('idea', { branch: 'main-id', seq: 1 })
    server.commit([ops.setText('a', 'title', 'A2')], OTHER.id, 'idea')
    await openLive('idea')
    await history.open()
    expect(snap().head).toBe(1)
    expect(snap().activities.map((a) => a.lines)).toEqual([['Renamed Card A → A2']])
    history.preview(0)
    expect(snap().preview?.cards.map((c) => c.title)).toEqual(['A'])
  })
})

describe('history stays current', () => {
  it('appends Changes arriving over the socket, extending the last Activity', async () => {
    server.commit([card('a', 'A')], OTHER.id)
    const ws = await openLive()
    await history.open()
    ws.receive(server.external([card('b', 'B')]))
    expect(snap().head).toBe(2)
    expect(snap().activities).toHaveLength(1)
    expect(snap().activities[0]).toMatchObject({ toSeq: 2, count: 2, lines: ['Added Card A', 'Added Card B'] })
  })
  it('sees my own Changes exactly once, whether the HTTP answer or the socket frame comes first', async () => {
    const ws = await openLive()
    await history.open()
    await sync.submit([card('a', 'A')])
    ws.receive(server.lastPostFrame!) // the echo, after the answer
    expect(snap().head).toBe(1)
    let release!: () => void
    server.responseGate = new Promise<void>((r) => (release = r))
    const p = sync.submit([card('b', 'B')])
    await settle()
    ws.receive(server.lastPostFrame!) // the echo, before the answer
    expect(snap().head).toBe(2)
    release()
    await p
    expect(snap().head).toBe(2)
    expect(snap().activities).toHaveLength(1)
    expect(snap().activities[0]!.lines).toEqual(['Added Card A', 'Added Card B'])
    expect(gets('/changes?after=0')).toHaveLength(1)
  })
  it('starts a new Activity for another author and keeps the finished ones by identity', async () => {
    server.now = 1000
    server.commit([card('a', 'A')], ME.id)
    server.commit([card('b', 'B')], OTHER.id)
    const ws = await openLive()
    await history.open()
    const [first, second] = snap().activities
    ws.receive(server.external([card('c', 'C')], ME.id))
    expect(snap().activities).toHaveLength(3)
    expect(snap().activities[0]).toBe(first)
    expect(snap().activities[1]).toBe(second)
    ws.receive(server.external([ops.setText('a', 'title', 'A2')], ME.id))
    expect(snap().activities).toHaveLength(3)
    expect(snap().activities[1]).toBe(second)
    expect(snap().activities[2]!.lines).toEqual(['Added Card C', 'Renamed Card A → A2'])
  })
  it('splits a later Change into a new Activity after a long pause', async () => {
    const ws = await openLive()
    await history.open()
    server.now = 0
    ws.receive(server.external([card('a', 'A')]))
    server.now = 11 * 60_000
    ws.receive(server.external([card('b', 'B')]))
    expect(snap().activities.map((a) => a.lines)).toEqual([['Added Card A'], ['Added Card B']])
  })
  it('matches a fresh load after many incremental updates', async () => {
    const ws = await openLive()
    await history.open()
    const authors = [ME.id, ME.id, OTHER.id, ME.id, OTHER.id, OTHER.id]
    authors.forEach((author, i) => {
      server.now = i * 1000
      ws.receive(server.external([card(`c${i}`, `T${i}`)], author))
      if (i > 0) ws.receive(server.external([ops.setText(`c${i - 1}`, 'title', `R${i}`)], author))
    })
    const live = snap().activities
    const fresh = createHistory(sync)
    await fresh.open()
    expect(live).toEqual(fresh.store.getState().snapshot.activities)
  })
  it('loads again when the Board had to be refetched and Changes were never seen', async () => {
    const ws = await openLive()
    await history.open()
    server.commit([card('a', 'A'), card('b', 'B')], OTHER.id) // frames lost
    // A frame that fits by number but cannot apply makes the Board layer refetch the whole Board.
    const bad: Change = { id: 'bad', author: 'other', at: 0, op: ops.remove('ghost'), origin: 'Edit' }
    ws.receive({ type: 'changes', branch: 'main-id', seq: 1, changes: [bad] })
    await settle()
    expect(board().seq).toBe(2)
    expect(snap()).toMatchObject({ status: 'ready', head: 2 })
    expect(snap().activities[0]!.lines).toEqual(['Added Card A', 'Added Card B'])
    expect(gets('/changes?after=0')).toHaveLength(2)
  })
  it('goes to error when that reload fails', async () => {
    const ws = await openLive()
    await history.open()
    server.commit([card('a', 'A'), card('b', 'B')], OTHER.id)
    server.failChanges = true
    const bad: Change = { id: 'bad', author: 'other', at: 0, op: ops.remove('ghost'), origin: 'Edit' }
    ws.receive({ type: 'changes', branch: 'main-id', seq: 1, changes: [bad] })
    await settle()
    expect(snap().status).toBe('error')
    server.failChanges = false
    await history.open()
    expect(snap()).toMatchObject({ status: 'ready', head: 2 })
  })
  it('reloads in place on a gap and ends with the whole log', async () => {
    const ws = await openLive()
    await history.open()
    server.commit([card('a', 'A')], OTHER.id) // frame lost
    ws.receive(server.external([card('b', 'B')])) // the Board catches up over HTTP: one event with both
    await settle()
    expect(board().seq).toBe(2)
    expect(snap()).toMatchObject({ status: 'ready', head: 2 })
    expect(snap().activities[0]!.lines).toEqual(['Added Card A', 'Added Card B'])
  })
  it('does not lose Changes that arrive while it is loading', async () => {
    server.commit([card('a', 'A')], OTHER.id)
    const ws = await openLive()
    const opening = history.open()
    ws.receive(server.external([card('b', 'B')]))
    ws.receive(server.external([card('c', 'C')]))
    await opening
    expect(snap().head).toBe(3)
    expect(snap().activities[0]!.count).toBe(3)
  })
  it('adds a Checkpoint from the socket frame to the list and its Activity, once', async () => {
    server.commit([card('a', 'A')], ME.id)
    server.commit([card('b', 'B')], OTHER.id)
    const ws = await openLive()
    await history.open()
    const untouched = snap().activities[1]
    const cp = server.checkpoint('named', 1, OTHER.id)
    ws.receive(server.checkpointFrame(cp))
    ws.receive(server.checkpointFrame(cp))
    expect(snap().checkpoints).toEqual([cp])
    expect(snap().activities[0]!.checkpoints).toEqual([cp])
    expect(snap().activities[1]).toBe(untouched)
    expect(snap().branch?.checkpoints).toBe(1)
    const zero = server.checkpoint('origin', 0, OTHER.id)
    ws.receive(server.checkpointFrame(zero))
    expect(snap().checkpoints.map((c) => c.name)).toEqual(['origin', 'named'])
    expect(snap().activities.flatMap((a) => a.checkpoints)).toEqual([cp])
  })
  it('splits the Activity a new Checkpoint falls in, keeping the others, as a fresh load would', async () => {
    server.commit([card('a', 'A')], OTHER.id)
    server.commit([card('b', 'B'), card('c', 'C'), ops.setText('a', 'title', 'A2')], ME.id)
    const ws = await openLive()
    await history.open()
    const [first, second] = snap().activities
    expect(second).toMatchObject({ fromSeq: 1, toSeq: 4 })
    const cp = server.checkpoint('mid', 2, OTHER.id)
    ws.receive(server.checkpointFrame(cp))
    const now = snap().activities
    expect(now[0]).toBe(first)
    expect(now.map((a) => [a.fromSeq, a.toSeq, a.lines])).toEqual([
      [0, 1, ['Added Card A']],
      [1, 2, ['Added Card B']],
      [2, 4, ['Added Card C', 'Renamed Card A → A2']],
    ])
    expect(now[1]!.checkpoints).toEqual([cp])
    // The tail goes on from the right place: a new Change by the same author joins the last part.
    ws.receive(server.external([card('d', 'D')], ME.id))
    expect(snap().activities.map((a) => [a.fromSeq, a.toSeq])).toEqual([
      [0, 1],
      [1, 2],
      [2, 5],
    ])
    // A Checkpoint at the head ends the last Activity: the next Change starts another.
    ws.receive(server.checkpointFrame(server.checkpoint('head', 5, OTHER.id)))
    ws.receive(server.external([card('e', 'E')], ME.id))
    expect(snap().activities.map((a) => [a.fromSeq, a.toSeq])).toEqual([
      [0, 1],
      [1, 2],
      [2, 5],
      [5, 6],
    ])
    const fresh = createHistory(sync)
    await fresh.open()
    expect(snap().activities).toEqual(fresh.store.getState().snapshot.activities)
  })
  it('splits an earlier Activity, not the last one, when the Checkpoint falls there', async () => {
    server.commit([card('a', 'A'), card('b', 'B')], OTHER.id)
    server.commit([card('c', 'C')], ME.id)
    const ws = await openLive()
    await history.open()
    const last = snap().activities[1]
    ws.receive(server.checkpointFrame(server.checkpoint('early', 1, OTHER.id)))
    expect(snap().activities.map((a) => [a.author, a.fromSeq, a.toSeq])).toEqual([
      ['other', 0, 1],
      ['other', 1, 2],
      ['me', 2, 3],
    ])
    expect(snap().activities[2]).toBe(last)
    ws.receive(server.external([ops.setText('c', 'title', 'C2')], ME.id))
    expect(snap().activities.map((a) => a.lines)).toEqual([['Added Card A'], ['Added Card B'], ['Added Card C2']])
  })
  it('fetches Checkpoints again after a reconnect', async () => {
    const ws = await openLive()
    await history.open()
    ws.drop()
    server.checkpoint('while away', 0, OTHER.id)
    timers.fireNext()
    const next = FakeSocket.last()
    next.open()
    next.receive({ type: 'subscribed', branch: 'main-id', seq: 0 })
    await settle()
    expect(snap().checkpoints.map((c) => c.name)).toEqual(['while away'])
    expect(board().branch?.checkpoints).toBe(1)
  })
  it('corrects the Board layer count from the loaded list', async () => {
    await openLive()
    server.checkpoint('unseen', 0, OTHER.id) // created after the Branch list was read, frame missed
    await history.open()
    expect(board().branch?.checkpoints).toBe(1)
    expect(snap().branch?.checkpoints).toBe(1)
  })
  it('keeps branch current as seq moves', async () => {
    const ws = await openLive()
    await history.open()
    ws.receive(server.external([card('a')]))
    expect(snap().branch?.seq).toBe(1)
    expect(snap().branch).toBe(board().branch)
  })
})

describe('history resets', () => {
  it('on close(), clearing the preview', async () => {
    server.commit([card('a')], OTHER.id)
    await openLive()
    await history.open()
    history.preview(0)
    history.close()
    expect(snap()).toEqual({ status: 'idle', head: 0, activities: [], checkpoints: [], preview: null })
  })
  it('when the Board closes', async () => {
    server.commit([card('a')], OTHER.id)
    await openLive()
    await history.open()
    sync.close()
    expect(snap().status).toBe('idle')
    expect(snap().activities).toEqual([])
    expect(snap().branch).toBeUndefined()
  })
  it('when the Board switches Branch, and then follows only the new one once opened', async () => {
    server.commit([card('a', 'A')], OTHER.id)
    server.fork('idea', { branch: 'main-id', seq: 1 })
    await openLive()
    await history.open()
    history.preview(0)
    const ws = await openLive('idea')
    expect(snap()).toMatchObject({ status: 'idle', head: 0, preview: null })
    ws.receive(server.external([card('b', 'B')], OTHER.id, 'idea'))
    expect(snap().status).toBe('idle')
    await history.open()
    expect(snap()).toMatchObject({ status: 'ready', head: 1 })
    expect(snap().branch?.name).toBe('idea')
  })
  it('when the Board is reopened on the same Branch', async () => {
    await openLive()
    await history.open()
    await openLive()
    expect(snap().status).toBe('idle')
  })
  it('drops a load that finishes after the Board moved on', async () => {
    server.commit([card('a')], OTHER.id)
    server.fork('idea', { branch: 'main-id', seq: 0 })
    await openLive()
    const opening = history.open()
    await openLive('idea')
    await opening
    expect(snap().status).toBe('idle')
    expect(snap().head).toBe(0)
  })
  it('when the session ends', async () => {
    await openLive()
    await history.open()
    sessionStore.setState({ status: 'signed_out' }, true)
    expect(snap().status).toBe('idle')
  })
})

describe('history.preview', () => {
  beforeEach(async () => {
    server.now = 500
    server.commit([card('a', 'A'), card('b', 'B')], ME.id)
    server.now = 900
    server.commit([ops.setText('a', 'title', 'A2'), ops.remove('b')], OTHER.id)
    await openLive()
  })
  it('does nothing before History is open', () => {
    history.preview(1)
    expect(snap().preview).toBeNull()
  })
  it('shows the Board at a moment without any request, and null goes back to now', async () => {
    await history.open()
    const sent = server.requests.length
    history.preview(2)
    expect(snap().preview).toMatchObject({ seq: 2, at: 500 })
    expect(snap().preview?.cards.map((c) => c.title)).toEqual(['A', 'B'])
    history.preview(3)
    expect(snap().preview?.cards.map((c) => c.title)).toEqual(['A2', 'B'])
    history.preview(1)
    expect(snap().preview?.cards.map((c) => c.title)).toEqual(['A'])
    history.preview(0)
    expect(snap().preview).toMatchObject({ seq: 0, at: null, cards: [] })
    history.preview(null)
    expect(snap().preview).toBeNull()
    expect(server.requests).toHaveLength(sent)
  })
  it('clamps to [0, head] and ignores NaN', async () => {
    await history.open()
    history.preview(99)
    expect(snap().preview).toMatchObject({ seq: 4, at: 900 })
    history.preview(-1)
    expect(snap().preview?.seq).toBe(0)
    const before = snap()
    history.preview(Number.NaN)
    expect(snap()).toBe(before)
  })
  it('keeps the snapshot and item identity where nothing changed', async () => {
    await history.open()
    history.preview(4)
    expect(snap().preview?.cards[0]).toBe(board().cards[0]) // same as the live Board at the head
    history.preview(2)
    const two = snap()
    history.preview(2)
    expect(snap()).toBe(two)
    history.preview(3)
    expect(snap().preview?.cards[1]).toBe(two.preview?.cards[1])
    expect(snap().preview?.cards[0]).not.toBe(two.preview?.cards[0])
  })
  it('stays at its moment while new Changes arrive', async () => {
    await history.open()
    history.preview(2)
    const shown = snap().preview
    FakeSocket.last().receive(server.external([card('c', 'C')]))
    expect(snap().head).toBe(5)
    expect(snap().preview).toBe(shown)
  })
})

describe('history.createCheckpoint', () => {
  it('names the head by default and works without history.open()', async () => {
    server.commit([card('a')], OTHER.id)
    await openLive()
    const cp = await history.createCheckpoint('before the rewrite')
    expect(cp).toMatchObject({ name: 'before the rewrite', moment: { branch: 'main-id', seq: 1 }, author: 'me' })
    expect(server.requests.at(-1)).toMatchObject({
      method: 'POST',
      path: '/api/branches/main-id/checkpoints',
      body: { name: 'before the rewrite' },
    })
    expect(snap().status).toBe('idle')
    expect(board().branch?.checkpoints).toBe(1)
  })
  it('names an earlier moment and shows up in History once, even when the frame follows', async () => {
    server.commit([card('a'), card('b')], OTHER.id)
    const ws = await openLive()
    await history.open()
    const cp = await history.createCheckpoint('early', 1)
    expect(server.requests.at(-1)?.body).toEqual({ name: 'early', seq: 1 })
    ws.receive(server.checkpointFrame(cp))
    expect(snap().checkpoints).toEqual([cp])
    expect(snap().activities[0]!.checkpoints).toEqual([cp])
    expect(board().branch?.checkpoints).toBe(1)
  })
  it('rejects with the server error and changes nothing', async () => {
    await openLive()
    await history.open()
    await history.createCheckpoint('one')
    await expect(history.createCheckpoint('one')).rejects.toMatchObject({ status: 409, code: 'name_taken' })
    await expect(history.createCheckpoint('  ')).rejects.toMatchObject({ status: 400 })
    await expect(history.createCheckpoint('far', 9)).rejects.toMatchObject({ status: 400 })
    expect(snap().checkpoints).toHaveLength(1)
    expect(board().branch?.checkpoints).toBe(1)
  })
  it('needs an open Board', async () => {
    await expect(history.createCheckpoint('x')).rejects.toMatchObject({ code: 'board_not_open' })
  })
})

describe('history.restore', () => {
  it('returns the Board to the earlier moment; the Changes arrive as a Restore Activity', async () => {
    server.commit([card('a', 'A')], ME.id)
    server.commit([card('b', 'B'), ops.setText('a', 'title', 'A2')], OTHER.id)
    const ws = await openLive()
    await history.open()
    await history.restore(1)
    expect(server.requests.at(-1)).toMatchObject({ path: '/api/branches/main-id/restore', body: { to_seq: 1 } })
    expect(board().cards.map((c) => c.title)).toEqual(['A'])
    expect(board().seq).toBe(5)
    ws.receive(server.lastPostFrame!) // the broadcast of the same Changes
    expect(board().seq).toBe(5)
    const last = snap().activities.at(-1)!
    expect(snap().head).toBe(5)
    expect(last).toMatchObject({ kind: 'restore', author: 'me', fromSeq: 3, toSeq: 5, count: 2 })
    expect(last.lines).toEqual(['Restored to an earlier moment'])
  })
  it('can itself be undone by restoring to the moment before it', async () => {
    server.commit([card('a', 'A'), card('b', 'B')], ME.id)
    await openLive()
    await history.open()
    await history.restore(1)
    expect(board().cards.map((c) => c.id)).toEqual(['a'])
    await history.restore(2)
    expect(board().cards.map((c) => c.id)).toEqual(['a', 'b'])
    expect(snap().activities.map((a) => a.kind)).toEqual(['edit', 'restore', 'restore'])
  })
  it('resolves and changes nothing when the Board already matches', async () => {
    server.commit([card('a')], ME.id)
    await openLive()
    await history.open()
    const before = snap()
    await history.restore(1)
    expect(snap()).toBe(before)
    expect(board().seq).toBe(1)
  })
  it('works without history.open() and rejects a moment past the head', async () => {
    server.commit([card('a')], ME.id)
    await openLive()
    await history.restore(0)
    expect(board().cards).toEqual([])
    await expect(history.restore(99)).rejects.toMatchObject({ status: 400 })
  })
  it('does not touch the Board when it switched Branch before the answer came', async () => {
    server.commit([card('a')], ME.id)
    server.fork('idea', { branch: 'main-id', seq: 1 })
    await openLive()
    const restoring = history.restore(0)
    await openLive('idea')
    await restoring
    expect(board().cards.map((c) => c.id)).toEqual(['a'])
    expect(board().seq).toBe(0)
  })
})

describe('Guests', () => {
  beforeEach(async () => {
    server.actor = GUEST
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
    await openLive()
  })
  it('are refused locally by open, createCheckpoint and restore', async () => {
    const sent = server.requests.length
    const refused = { status: 403, code: 'forbidden' }
    await expect(history.open()).rejects.toMatchObject(refused)
    await expect(history.createCheckpoint('x')).rejects.toMatchObject(refused)
    await expect(history.restore(0)).rejects.toMatchObject(refused)
    history.preview(0)
    history.close()
    expect(server.requests).toHaveLength(sent)
    expect(snap().status).toBe('idle')
  })
})
