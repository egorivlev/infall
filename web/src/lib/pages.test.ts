import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from 'zustand'
import { EMPTY_PAGE } from './board-state'
import { createBoardSync } from './board-sync'
import { ops } from './ops'
import { orderBetween } from './order'
import { membersStore } from './people'
import { sessionStore } from './session-store'
import { FakeServer, FakeSocket, FakeTimers, GUEST, ME, OTHER, settle } from './testing'
import { todosInternal } from './todos'
import type { ClientFrame, Op } from './types'

let server: FakeServer
let timers: FakeTimers
let sync: ReturnType<typeof createBoardSync>

const snap = () => sync.store.getState().snapshot
const card = (id: string, title = id.toUpperCase()): Op => ops.createCard({ id, x: 0, y: 0, title })
const editingFrames = (ws: FakeSocket) => ws.sent.filter((f): f is Extract<ClientFrame, { type: 'editing' }> => f.type === 'editing')

async function openLive() {
  await sync.open()
  const ws = FakeSocket.last()
  ws.open()
  ws.receive({ type: 'subscribed', branch: server.branch.id, seq: server.seq })
  await settle()
  return ws
}

async function reconnect() {
  FakeSocket.last().drop()
  timers.fireNext()
  const ws = FakeSocket.last()
  ws.open()
  ws.receive({ type: 'subscribed', branch: server.branch.id, seq: server.seq })
  await settle()
  return ws
}

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((r) => (release = r))
  return { promise, release }
}

// Card `a` with two blocks and a Source; Card `b` beside it.
function seed() {
  server.commit(
    [
      card('a'),
      card('b'),
      ops.addBlock({ id: 'k1', card: 'a', text: 'first', order: 'G' }),
      ops.addBlock({ id: 'k2', card: 'a', text: 'second', order: 'V' }),
      ops.createSource({ id: 's1', title: 'Paper', doi: '10.1000/Paper', url: 'https://example.com/paper/' }),
      ops.attach({ id: 'at1', card: 'a', source: 's1' }),
    ],
    OTHER.id,
  )
}

beforeEach(() => {
  server = new FakeServer()
  timers = new FakeTimers()
  FakeSocket.all = []
  vi.stubGlobal('fetch', server.fetch)
  sessionStore.setState({ status: 'signed_in', member: ME }, true)
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

describe('the Page of a Card', () => {
  it('is empty before the Board is open, for no Card, and for a Card that is not there', async () => {
    expect(sync.page('a')).toBe(EMPTY_PAGE)
    seed()
    await openLive()
    expect(sync.page(null)).toBe(EMPTY_PAGE)
    expect(sync.page('ghost')).toBe(EMPTY_PAGE)
    sync.close()
    expect(sync.page('a')).toBe(EMPTY_PAGE)
    expect(sync.sources()).toEqual([])
  })

  it('is loaded with the Board, and the Cards carry the counts', async () => {
    seed()
    await openLive()
    const p = sync.page('a')
    expect(p.card).toBe(snap().cards[0])
    expect(p.card).toMatchObject({ id: 'a', blocks: 2, sources: 1 })
    expect(p.blocks.map((b) => [b.id, b.text])).toEqual([
      ['k1', 'first'],
      ['k2', 'second'],
    ])
    expect(p.sources).toEqual([
      { id: 's1', url: 'https://example.com/paper/', doi: '10.1000/Paper', title: 'Paper', authors: '', year: '', note: '', cards: ['a'], attachment: 'at1' },
    ])
    expect(sync.sources().map((s) => s.id)).toEqual(['s1'])
    expect(sync.page('b')).toMatchObject({ card: { id: 'b', blocks: 0, sources: 0 }, blocks: [], sources: [] })
  })

  it('shows an edit at once, before the server answers', async () => {
    seed()
    await openLive()
    const gate = deferred()
    server.gate = gate.promise
    const between = orderBetween('G', 'V')
    const done = sync.submit([
      ops.setBlockText('k1', 'first, rewritten'),
      ops.addBlock({ id: 'k3', card: 'a', text: 'between', order: between }),
      ops.remove('k2'),
    ])
    expect(sync.page('a').blocks.map((b) => [b.id, b.text])).toEqual([
      ['k1', 'first, rewritten'],
      ['k3', 'between'],
    ])
    expect(snap().pending).toBe(3)
    expect(snap().cards[0]).toMatchObject({ id: 'a', blocks: 2 })
    gate.release()
    await done
    expect(snap().pending).toBe(0)
    expect(sync.page('a').blocks.map((b) => b.id)).toEqual(['k1', 'k3'])
    expect(server.entities.k2?.deleted).toBe(true)
  })

  it('takes a refused edit back and rejects', async () => {
    seed()
    await openLive()
    const before = sync.page('a')
    server.failNext = { status: 409, code: 'rejected' }
    const done = sync.submit([ops.setBlockText('k1', 'nope'), ops.attach({ id: 'at2', card: 'b', source: 's1' })])
    expect(sync.page('a').blocks[0]!.text).toBe('nope')
    expect(sync.page('a').sources[0]!.cards).toEqual(['a', 'b'])
    expect(snap().cards[1]).toMatchObject({ id: 'b', sources: 1 })
    await expect(done).rejects.toMatchObject({ status: 409, code: 'rejected' })
    expect(sync.page('a').blocks[0]!.text).toBe('first')
    expect(sync.page('a').sources[0]!.cards).toEqual(['a'])
    expect(snap().cards[1]).toMatchObject({ id: 'b', sources: 0 })
    expect(sync.page('a').blocks[1]).toBe(before.blocks[1])
  })

  it('refuses locally an edit that cannot apply: a block of a missing Card, text of a deleted block', async () => {
    seed()
    await openLive()
    const posts = () => server.requests.filter((r) => r.method === 'POST').length
    const sent = posts()
    await expect(sync.submit([ops.addBlock({ card: 'ghost', text: 'x', order: 'V' })])).rejects.toMatchObject({ code: 'rejected' })
    await sync.submit([ops.remove('k1')])
    await expect(sync.submit([ops.setBlockText('k1', 'x')])).rejects.toMatchObject({ code: 'rejected' })
    expect(posts()).toBe(sent + 1)
    await sync.submit([ops.restore('k1'), ops.setBlockText('k1', 'back')])
    expect(sync.page('a').blocks[0]).toMatchObject({ id: 'k1', text: 'back' })
  })

  it('follows what other Members do', async () => {
    seed()
    const ws = await openLive()
    ws.receive(server.external([ops.setBlockText('k2', 'by someone else'), ops.moveBlock('k2', 'A')]))
    expect(sync.page('a').blocks.map((b) => [b.id, b.text])).toEqual([
      ['k2', 'by someone else'],
      ['k1', 'first'],
    ])
    ws.receive(server.external([ops.remove('at1')]))
    expect(sync.page('a').sources).toEqual([])
    expect(snap().cards[0]).toMatchObject({ sources: 0 })
    expect(sync.sources()[0]).toMatchObject({ id: 's1', cards: [] })
    ws.receive(server.external([ops.remove('a')]))
    expect(sync.page('a')).toBe(EMPTY_PAGE)
  })

  it('keeps its identity while other things on the Board change', async () => {
    seed()
    const ws = await openLive()
    const p = sync.page('a')
    const board = snap()
    expect(sync.page('a')).toBe(p)
    // An unrelated Card moves, here and from someone else; a block is added to another Page.
    await sync.submit(ops.move('b', 40, 40))
    ws.receive(server.external(ops.move('b', 80, 80)))
    ws.receive(server.external([ops.addBlock({ id: 'kb', card: 'b', text: 'elsewhere', order: 'V' })]))
    ws.receive({ type: 'presence', branch: server.branch.id, members: [ME.id] })
    expect(snap()).not.toBe(board)
    expect(sync.page('a')).toBe(p)
    // A keystroke in this Page: a new Page, but the Board snapshot's Cards are the same objects.
    const cards = snap().cards
    await sync.submit([ops.setBlockText('k1', 'first!')])
    const typed = sync.page('a')
    expect(typed).not.toBe(p)
    expect(typed.blocks[1]).toBe(p.blocks[1])
    expect(typed.sources).toBe(p.sources)
    expect(snap().cards).toBe(cards)
    // The Card itself moves: the Page shows the new Card, its lists stay.
    await sync.submit(ops.move('a', 7, 7))
    expect(sync.page('a').card).toMatchObject({ x: 7 })
    expect(sync.page('a').blocks).toBe(typed.blocks)
  })

  it('does not re-render a component reading one Page when an unrelated Card moves', async () => {
    seed()
    const ws = await openLive()
    let renders = 0
    const { result, unmount } = renderHook(() => {
      renders++
      return useStore(sync.store, () => sync.page('a'))
    })
    const sources = renderHook(() => useStore(sync.store, (s) => s.pages.sources))
    const first = result.current
    const start = renders
    await act(async () => {
      await sync.submit(ops.move('b', 40, 40))
      ws.receive(server.external([card('c'), ops.addBlock({ id: 'kc', card: 'c', text: 'x', order: 'V' })]))
    })
    expect(renders).toBe(start)
    expect(result.current).toBe(first)
    const listed = sources.result.current
    await act(async () => {
      await sync.submit([ops.setBlockText('k2', 'typed')])
    })
    expect(renders).toBeGreaterThan(start)
    expect(result.current.blocks[1]!.text).toBe('typed')
    expect(sources.result.current).toBe(listed)
    unmount()
    sources.unmount()
  })
})

describe('Sources of the open Branch', () => {
  it('finds a Source by a DOI or an address written another way, optimistic ones included', async () => {
    seed()
    await openLive()
    expect(sync.findSource({ doi: 'https://doi.org/10.1000/PAPER' })?.id).toBe('s1')
    expect(sync.findSource({ url: 'HTTPS://Example.com/paper#abstract' })?.id).toBe('s1')
    expect(sync.findSource({ doi: '10.1000/other', url: 'https://example.com/other' })).toBeUndefined()
    const gate = deferred()
    server.gate = gate.promise
    const done = sync.submit([ops.createSource({ id: 's2', url: 'https://arxiv.org/abs/1234.5678' })])
    expect(sync.findSource({ url: 'https://arxiv.org/abs/1234.5678/' })?.id).toBe('s2')
    gate.release()
    await done
    await sync.submit([ops.remove('s1')])
    expect(sync.findSource({ doi: '10.1000/paper' })).toBeUndefined()
  })

  it('lists Sources by title and keeps the list while Pages are typed in', async () => {
    seed()
    await openLive()
    await sync.submit([ops.createSource({ id: 's0', title: 'An earlier paper' })])
    const list = sync.sources()
    expect(list.map((s) => s.id)).toEqual(['s0', 's1'])
    await sync.submit([ops.setBlockText('k1', 'typing')])
    expect(sync.sources()).toBe(list)
    await sync.submit([ops.attach({ id: 'at2', card: 'b', source: 's0' })])
    expect(sync.sources()[0]).toMatchObject({ id: 's0', cards: ['b'] })
    expect(sync.sources()[1]).toBe(list[1])
  })
})

describe('who is editing a Page', () => {
  it('claims once, lets go once, and says nothing twice', async () => {
    seed()
    const ws = await openLive()
    sync.startEditing('a')
    sync.startEditing('a')
    expect(editingFrames(ws)).toEqual([{ type: 'editing', card: 'a' }])
    sync.startEditing('b')
    sync.stopEditing()
    sync.stopEditing()
    expect(editingFrames(ws)).toEqual([
      { type: 'editing', card: 'a' },
      { type: 'editing', card: 'b' },
      { type: 'editing', card: null },
    ])
  })

  it('waits for the subscription before claiming', async () => {
    seed()
    await sync.open()
    const ws = FakeSocket.last()
    sync.startEditing('a')
    ws.open()
    expect(editingFrames(ws)).toEqual([])
    ws.receive({ type: 'subscribed', branch: server.branch.id, seq: server.seq })
    expect(ws.sent).toEqual([
      { type: 'subscribe', branch: 'main-id', after: server.seq },
      { type: 'editing', card: 'a' },
    ])
  })

  it('ignores a claim while no Board is open', () => {
    sync.startEditing('a')
    sync.stopEditing()
    expect(FakeSocket.all).toEqual([])
  })

  it('shows who else holds a Page, not our own claim', async () => {
    seed()
    membersStore.setState({ members: [ME, OTHER] })
    const ws = await openLive()
    sync.startEditing('a')
    server.now = 500
    ws.receive(server.claim(ME.id, 'a'))
    expect(sync.page('a').editor).toBeNull()
    ws.receive(server.claim(OTHER.id, 'b'))
    expect(sync.page('b').editor).toEqual({ member: OTHER, memberId: OTHER.id, since: 500 })
    expect(sync.page('a').editor).toBeNull()
    // The same frame again changes nothing.
    const held = sync.page('b')
    ws.receive(server.editingFrame())
    expect(sync.page('b')).toBe(held)
    ws.receive(server.claim(OTHER.id, null))
    expect(sync.page('b').editor).toBeNull()
  })

  it('shows the first claimant when someone else was first on the Page we want', async () => {
    seed()
    membersStore.setState({ members: [ME, OTHER] })
    const ws = await openLive()
    ws.receive(server.claim(OTHER.id, 'a'))
    sync.startEditing('a')
    ws.receive(server.claim(ME.id, 'a'))
    expect(sync.page('a').editor?.memberId).toBe(OTHER.id)
    ws.receive(server.claim(OTHER.id, null))
    expect(sync.page('a').editor).toBeNull()
  })

  it('names an editor it does not know yet once the Member list arrives', async () => {
    seed()
    const ws = await openLive()
    const asked = () => server.requests.filter((r) => r.path === '/api/members').length
    ws.receive(server.claim(OTHER.id, 'a'))
    expect(sync.page('a').editor).toEqual({ member: null, memberId: OTHER.id, since: 0 })
    await settle()
    expect(asked()).toBe(1)
    expect(sync.page('a').editor?.member).toEqual(OTHER)
    ws.receive(server.editingFrame())
    await settle()
    expect(asked()).toBe(1)
  })

  it('ignores frames about another Branch', async () => {
    seed()
    const ws = await openLive()
    ws.receive({ type: 'editing', branch: 'elsewhere', editors: [{ card: 'a', member: OTHER.id, since: 1 }] })
    expect(sync.page('a').editor).toBeNull()
  })

  it('claims again after a reconnect, and forgets who held what while away', async () => {
    seed()
    const ws = await openLive()
    sync.startEditing('a')
    ws.receive(server.claim(OTHER.id, 'b'))
    expect(sync.page('b').editor).not.toBeNull()
    ws.drop()
    expect(sync.page('b').editor).toBeNull()
    // Changing our mind while offline: only the last claim is made again.
    sync.startEditing('b')
    timers.fireNext()
    const next = FakeSocket.last()
    next.open()
    expect(editingFrames(next)).toEqual([])
    next.receive({ type: 'subscribed', branch: server.branch.id, seq: server.seq })
    expect(editingFrames(next)).toEqual([{ type: 'editing', card: 'b' }])
    expect(editingFrames(ws)).toEqual([{ type: 'editing', card: 'a' }])
  })

  it('does not claim again after a reconnect once it let go', async () => {
    seed()
    const ws = await openLive()
    sync.startEditing('a')
    ws.drop()
    sync.stopEditing()
    const next = await reconnect()
    expect(editingFrames(next)).toEqual([])
    expect(editingFrames(ws)).toEqual([{ type: 'editing', card: 'a' }])
  })

  it('drops the claim when the Board closes', async () => {
    seed()
    const ws = await openLive()
    sync.startEditing('a')
    sync.close()
    expect(editingFrames(ws).at(-1)).toEqual({ type: 'editing', card: null })
    expect(ws.closed).toBe(true)
    const again = await openLive()
    expect(editingFrames(again)).toEqual([])
  })

  it('drops the claim on a Branch switch', async () => {
    seed()
    server.fork('try', { branch: 'main-id', seq: server.seq })
    const ws = await openLive()
    sync.startEditing('a')
    ws.receive(server.claim(OTHER.id, 'b'))
    await sync.open('try')
    expect(editingFrames(ws).at(-1)).toEqual({ type: 'editing', card: null })
    const next = FakeSocket.last()
    next.open()
    next.receive({ type: 'subscribed', branch: 'try-id', seq: 0 })
    expect(editingFrames(next)).toEqual([])
    expect(sync.page('b').editor).toBeNull()
    expect(sync.page('a').blocks).toHaveLength(2)
  })
})

describe('a Guest', () => {
  beforeEach(() => {
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
    server.actor = GUEST
  })

  it('reads Pages and Sources, is not told who is editing, and never claims or edits', async () => {
    seed()
    const ws = await openLive()
    expect(snap().readOnly).toBe(true)
    expect(sync.page('a').blocks).toHaveLength(2)
    expect(sync.page('a').sources.map((s) => s.id)).toEqual(['s1'])
    expect(sync.findSource({ doi: '10.1000/paper' })?.id).toBe('s1')
    sync.startEditing('a')
    sync.stopEditing()
    expect(editingFrames(ws)).toEqual([])
    ws.receive(server.claim(OTHER.id, 'a'))
    expect(sync.page('a').editor).toBeNull() // M6: such a frame is not for a Guest
    await settle()
    expect(server.requests.some((r) => r.path === '/api/members')).toBe(false)
    await expect(sync.submit([ops.setBlockText('k1', 'x')])).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    expect(server.requests.some((r) => r.method === 'POST')).toBe(false)
    const next = await reconnect()
    expect(editingFrames(next)).toEqual([])
  })
})
