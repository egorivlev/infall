import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBoardSync } from './board-sync'
import { ops } from './ops'
import { membersStore } from './people'
import { sessionStore } from './session-store'
import { createSuggestions } from './suggestions'
import { FakeServer, FakeSocket, FakeTimers, ME, OTHER, settle } from './testing'
import type { Member, Op } from './types'
import { createUndo, undoFor } from './undo-store'
import { NOTHING_TO_REDO, NOTHING_TO_UNDO } from './undo'

const ANA: Member = { ...OTHER, name: 'Ana Ruiz' }

let server: FakeServer
let timers: FakeTimers
let sync: ReturnType<typeof createBoardSync>
let u: ReturnType<typeof createUndo>
let ws: FakeSocket

const entity = (id: string) => sync.internal.entities()[id]
const field = (id: string, name: string) => entity(id)?.fields[name]
const posts = () => server.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/ops'))

async function openLive(branch = 'main') {
  await sync.open(branch)
  ws = FakeSocket.last()
  ws.open()
  ws.receive({ type: 'subscribed', branch: server.find(branch).info.id, seq: server.find(branch).log.length })
  await settle()
}

/** A gesture as the UI makes one: its submits inside `undo.gesture`. */
async function gesture(list: Op[], options = {}) {
  await u.gesture(() => sync.submit(list), options)
  await settle()
}

/** Someone else's Change, arriving over the socket. */
function theirs(list: Op[], author = ANA.id) {
  ws.receive(server.external(list, author))
}

beforeEach(async () => {
  server = new FakeServer()
  server.members = [ME, ANA]
  timers = new FakeTimers()
  FakeSocket.all = []
  vi.stubGlobal('fetch', server.fetch)
  sessionStore.setState({ status: 'signed_in', member: ME }, true)
  membersStore.setState({ members: [ME, ANA] })
  sync = createBoardSync({ WebSocketCtor: FakeSocket, setTimer: timers.set, clearTimer: timers.clear, socketUrl: () => 'ws://test/api/ws' })
  u = createUndo(sync)
  server.commit(
    [
      ops.createCard({ id: 'a', x: 0, y: 0, title: 'Axions' }),
      ops.createCard({ id: 'b', x: 300, y: 0, title: 'Bosons' }),
      ops.createCard({ id: 'c', x: 600, y: 0, title: 'Chirality' }),
      ops.createConnection({ id: 'ab', from: 'a', to: 'b' }),
    ],
    ANA.id,
  )
  await openLive()
})

afterEach(() => {
  u.internal.dispose()
  sync.close()
  vi.unstubAllGlobals()
})

describe('steps', () => {
  it('one gesture is one step, named in History’s words, and Undo and Redo take it back and do it again', async () => {
    expect(u.current()).toEqual({ undo: null, redo: null })
    await gesture([...ops.move('a', 40, 40), ...ops.move('b', 340, 40), ...ops.move('c', 640, 40)])
    expect(u.current()).toEqual({ undo: 'Move 3 Cards', redo: null })
    expect(await u.undo()).toEqual({ done: true, note: 'Undid Move 3 Cards.' })
    expect(field('a', 'x')).toEqual({ Float: 0 })
    expect(field('c', 'y')).toEqual({ Float: 0 })
    expect(u.current()).toEqual({ undo: null, redo: 'Move 3 Cards' })
    expect(await u.redo()).toEqual({ done: true, note: 'Redid Move 3 Cards.' })
    expect(field('b', 'x')).toEqual({ Float: 340 })
    expect(u.current()).toEqual({ undo: 'Move 3 Cards', redo: null })
    expect(server.log.slice(-6).every((c) => c.author === ME.id && c.origin === 'Edit')).toBe(true) // honest History
  })
  it('says when there is nothing to undo or redo', async () => {
    expect(await u.undo()).toEqual({ done: false, note: NOTHING_TO_UNDO })
    expect(await u.redo()).toEqual({ done: false, note: NOTHING_TO_REDO })
  })
  it('a submit outside a gesture is not a step', async () => {
    await sync.submit([ops.setText('a', 'title', 'Run result, say')])
    expect(u.current().undo).toBeNull()
  })
  it('a gesture of many batches is one step', async () => {
    const list = Array.from({ length: 250 }, (_, i) => ops.createCard({ id: `n${i}`, x: i, y: 0 }))
    await gesture([]) // nothing sent: nothing recorded
    await u.gesture(() => Promise.all([sync.submit(list.slice(0, 200)), sync.submit(list.slice(200))]))
    await settle()
    expect(u.current().undo).toBe('Add 250 Cards')
    const g = u.begin({ label: 'Import 3 entries from BibTeX' })
    await g.add(() => sync.submit([ops.createSource({ id: 's1', title: 'One' })]))
    await g.add(() => sync.submit([ops.createSource({ id: 's2', title: 'Two' }), ops.createSource({ id: 's3', title: 'Three' })]))
    g.end()
    await settle()
    expect(u.current().undo).toBe('Import 3 entries from BibTeX')
    expect((await u.undo())?.note).toBe('Undid Import 3 entries from BibTeX.')
    expect(['s1', 's2', 's3'].map((id) => entity(id)?.deleted)).toEqual([true, true, true])
    expect((await u.undo())?.note).toBe('Undid Add 250 Cards.')
    expect(posts().at(-1)?.body).toMatchObject({ ops: expect.any(Array) })
    expect(entity('n249')?.deleted).toBe(true)
    expect(entity('n0')?.deleted).toBe(true)
  })
  it('a new gesture clears what could be redone', async () => {
    await gesture([ops.setStatus('a', 'reading')])
    await u.undo()
    expect(u.current().redo).toBe('Status: Axions → Reading')
    await gesture([ops.setStatus('b', 'reading')])
    expect(u.current()).toEqual({ undo: 'Status: Bosons → Reading', redo: null })
  })
  it('Undo and Redo send ops that register nothing', async () => {
    await gesture([ops.setText('a', 'title', 'Axion')])
    await u.undo()
    await u.redo()
    await u.undo()
    expect(u.current()).toEqual({ undo: null, redo: 'Rename Card Axions → Axion' })
  })
  it('keeps 100 steps; the 101st back is gone without error', async () => {
    for (let i = 1; i <= 101; i++) await gesture(ops.move('a', i, 0))
    let n = 0
    for (;;) {
      const r = await u.undo()
      if (!r?.done) {
        expect(r?.note).toBe(NOTHING_TO_UNDO)
        break
      }
      n++
    }
    expect(n).toBe(100)
    expect(field('a', 'x')).toEqual({ Float: 1 }) // where step 1 left it
  })
  it('a refused batch is no step', async () => {
    server.failNext = { status: 409, code: 'rejected' }
    await gesture([ops.setStatus('a', 'reading')]).catch(() => {})
    await settle()
    expect(u.current().undo).toBeNull()
  })
  it('the toast’s Undo undoes only its own step', async () => {
    await gesture([ops.remove('c')], { key: 'remove:1' })
    await gesture([ops.setStatus('a', 'reading')])
    expect(await u.undo('remove:1')).toBeNull()
    expect(u.current().undo).toBe('Status: Axions → Reading')
  })
})

describe('joining', () => {
  it('the title typed into a new Card is part of adding it', async () => {
    await gesture([ops.createCard({ id: 'n', x: 0, y: 300 })], { key: 'new:n' })
    expect(u.current().undo).toBe('Add Card Untitled')
    await gesture([ops.setText('n', 'title', 'Neutrinos')], { join: 'new:n' })
    expect(u.current().undo).toBe('Add Card Neutrinos')
    const before = posts().length
    expect((await u.undo())?.note).toBe('Undid Add Card Neutrinos.')
    expect(posts().slice(before).map((p) => p.body)).toEqual([{ ops: [ops.remove('n')] }])
    expect(u.current()).toEqual({ undo: null, redo: 'Add Card Neutrinos' })
  })
  it('joins only the newest step', async () => {
    await gesture([ops.createCard({ id: 'n', x: 0, y: 300 })], { key: 'new:n' })
    await gesture([ops.setStatus('a', 'reading')])
    await gesture([ops.setText('n', 'title', 'Neutrinos')], { join: 'new:n' })
    expect(u.current().undo).toBe('Rename Card Untitled → Neutrinos')
  })
  it('an empty block added and taken away again leaves no step', async () => {
    await gesture([ops.setStatus('a', 'reading')])
    await gesture([ops.addBlock({ id: 'k', card: 'a', text: '', order: 'U' })], { key: 'new:k' })
    expect(u.current().undo).toBe('Add a block to the Page of Axions')
    await gesture([ops.remove('k')], { join: 'new:k' })
    expect(u.current().undo).toBe('Status: Axions → Reading')
    // …and the Changes it made do not count as "mine from elsewhere" against the Card.
    expect((await u.undo())?.note).toBe('Undid Status: Axions → Reading.')
  })
})

describe('never over someone else’s work', () => {
  it('leaves a field someone changed since and says who', async () => {
    await gesture([...ops.move('a', 40, 40), ...ops.move('b', 340, 40), ...ops.move('c', 640, 40)])
    theirs(ops.move('b', 999, 999))
    expect((await u.undo())?.note).toBe('Undid Move 3 Cards. 1 left as it is — Ana changed it since.')
    expect(field('b', 'x')).toEqual({ Float: 999 })
    expect(field('a', 'x')).toEqual({ Float: 0 })
  })
  it('they edit a title I edited: my Undo leaves it and drops the step', async () => {
    await gesture([ops.setStatus('c', 'reading')])
    await gesture([ops.setText('a', 'title', 'Axion')])
    theirs([ops.setText('a', 'title', 'Axion field')])
    expect(await u.undo()).toEqual({ done: false, note: 'Not undone — Ana changed this since.' })
    expect(field('a', 'title')).toEqual({ Text: 'Axion field' })
    expect(u.current().undo).toBe('Status: Chirality → Reading') // the next press goes to the one before
  })
  it('they move a Card I did not: my Undo of my own move still works', async () => {
    await gesture(ops.move('a', 50, 50))
    theirs(ops.move('b', 1, 1))
    expect((await u.undo())?.note).toBe('Undid Move 1 Card.')
  })
  it('they write on the Page of a Card I added: my Undo does not remove the Card', async () => {
    await gesture([ops.createCard({ id: 'n', x: 0, y: 300, title: 'New' })])
    theirs([ops.addBlock({ id: 'p', card: 'n', text: 'Their notes', order: 'U' })])
    expect(await u.undo()).toEqual({ done: false, note: 'Not undone — Ana changed this since.' })
    expect(entity('n')?.deleted).toBe(false)
  })
  it('my own Changes from elsewhere count too', async () => {
    await gesture([ops.setText('a', 'title', 'Axion')])
    ws.receive(server.external([ops.setText('a', 'title', 'From my other window')], ME.id))
    expect((await u.undo())?.note).toBe('Not undone — you changed this since.')
  })
  it('a deleted Card comes back whole, the same Card, without a Connection whose other end is gone', async () => {
    await gesture([ops.addBlock({ id: 'k', card: 'a', text: 'Notes', order: 'U' })])
    await gesture([ops.remove('a')])
    theirs([ops.remove('b')])
    expect((await u.undo())?.note).toBe('Undid Delete Card Axions. 1 Connection left out — the Card at its other end is gone.')
    expect(entity('a')?.deleted).toBe(false)
    expect(entity('k')?.deleted).toBe(false)
    expect(sync.store.getState().snapshot.connections).toEqual([])
  })
  it('redo follows the same rule', async () => {
    await gesture([ops.setText('a', 'title', 'Axion')])
    await u.undo()
    theirs([ops.setText('a', 'title', 'Theirs')])
    expect(await u.redo()).toEqual({ done: false, note: 'Not redone — Ana changed this since.' })
    expect(u.current().redo).toBeNull()
  })
})

describe('the list ends', () => {
  it('when a Restore lands on the Branch, by anyone', async () => {
    await gesture([ops.setStatus('a', 'reading')])
    const changes = server.restore(0, ANA.id)
    ws.receive(server.frameFor(changes))
    await settle()
    expect(u.current()).toEqual({ undo: null, redo: null })
    expect(await u.undo()).toEqual({ done: false, note: NOTHING_TO_UNDO })
  })
  it('when a Merge lands, and also when it landed while the Branch was not open', async () => {
    await gesture([ops.setStatus('a', 'reading')])
    server.fork('try', { branch: 'main-id', seq: server.seq })
    await openLive('try')
    expect(u.current().undo).toBeNull() // each Branch has its own list
    await gesture([ops.setStatus('b', 'understood')])
    await openLive('main')
    expect(u.current().undo).toBe('Status: Axions → Reading') // resumed on return
    await openLive('try')
    server.commit([ops.setStatus('b', 'dead_end')], ANA.id, 'try-id', { Merge: { batch: 'm', source: { branch: 'main-id', seq: 1 } } })
    await openLive('main')
    await openLive('try')
    await settle()
    expect(u.current().undo).toBeNull()
  })
  it('back on a Branch, what others did there meanwhile is checked', async () => {
    await gesture([ops.setText('a', 'title', 'Axion')])
    server.fork('try', { branch: 'main-id', seq: server.seq })
    await openLive('try')
    server.commit([ops.setText('a', 'title', 'Ana’s')], ANA.id, 'main-id')
    await openLive('main')
    expect(await u.undo()).toEqual({ done: false, note: 'Not undone — Ana changed this since.' })
    expect(server.requests.some((r) => r.path === '/api/branches/main-id/changes?after=5')).toBe(true)
  })
  it('when someone else signs in here', async () => {
    await gesture([ops.setStatus('a', 'reading')])
    sessionStore.setState({ status: 'signed_in', member: ANA }, true)
    expect(u.current().undo).toBeNull()
  })
})

describe('accepting a Suggestion', () => {
  it('is a step, and Undo removes what it added', async () => {
    u.internal.dispose()
    u = undoFor(sync) // the store `suggestions.ts` records into: one per Board layer
    const own = createSuggestions(sync)
    const s = server.suggest({ connection: { from: 'b', to: 'c', kind: 'related', label: 'pairs' } })
    await own.reload()
    await own.accept(s.id)
    await settle()
    expect(u.current().undo).toBe('Connect Bosons → Chirality')
    const made = sync.store.getState().snapshot.connections.find((c) => c.from === 'b' && c.to === 'c')
    expect(made).toBeDefined()
    expect((await u.undo())?.note).toBe('Undid Connect Bosons → Chirality.')
    expect(entity(made!.id)?.deleted).toBe(true)
    own.internal.dispose()
  })
})
