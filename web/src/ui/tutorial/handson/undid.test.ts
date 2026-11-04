// The Undo step's rule (undid.ts) against the real lists of steps (lib/undo-store) and the fake server, followed as
// the step's watcher follows them: every change the store tells of. Only an Undo that took something back is one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UndoSnapshot } from '../../../lib'
import { createBoardSync } from '../../../lib/board-sync'
import { ops } from '../../../lib/ops'
import { membersStore } from '../../../lib/people'
import { sessionStore } from '../../../lib/session-store'
import { FakeServer, FakeSocket, FakeTimers, ME, OTHER, settle } from '../../../lib/testing'
import type { Op } from '../../../lib/types'
import { createUndo } from '../../../lib/undo-store'
import { undid } from './undid'

const ANA = { ...OTHER, name: 'Ana Ruiz' }

let server: FakeServer
let sync: ReturnType<typeof createBoardSync>
let u: ReturnType<typeof createUndo>
let ws: FakeSocket
/** How many changes of the list read as an Undo so far. */
let undos: number
let stop: () => void

async function openLive(branch = 'main') {
  await sync.open(branch)
  ws = FakeSocket.last()
  ws.open()
  ws.receive({ type: 'subscribed', branch: server.find(branch).info.id, seq: server.find(branch).log.length })
  await settle()
}

async function gesture(list: Op[]) {
  await u.gesture(() => sync.submit(list))
  await settle()
}

beforeEach(async () => {
  server = new FakeServer()
  server.members = [ME, ANA]
  const timers = new FakeTimers()
  FakeSocket.all = []
  vi.stubGlobal('fetch', server.fetch)
  sessionStore.setState({ status: 'signed_in', member: ME }, true)
  membersStore.setState({ members: [ME, ANA] })
  sync = createBoardSync({ WebSocketCtor: FakeSocket, setTimer: timers.set, clearTimer: timers.clear, socketUrl: () => 'ws://test/api/ws' })
  u = createUndo(sync)
  server.commit([ops.createCard({ id: 'a', x: 0, y: 0, title: 'Axions' }), ops.createCard({ id: 'b', x: 300, y: 0, title: 'Bosons' })], ANA.id)
  await openLive()
  undos = 0
  let was: UndoSnapshot = u.current()
  stop = u.subscribe(() => {
    const now = u.current()
    if (undid(was, now)) undos++
    was = now
  })
})

afterEach(() => {
  stop()
  u.internal.dispose()
  sync.close()
  vi.unstubAllGlobals()
})

describe('the rule, from the names alone', () => {
  const at = (undo: string | null, redo: string | null) => ({ undo, redo })
  it('an Undo moves the newest step to the top of Redo', () => {
    expect(undid(at('Move 1 Card', null), at('Add Card Drift', 'Move 1 Card'))).toBe(true)
    expect(undid(at('Move 1 Card', 'Rename Card A → B'), at(null, 'Move 1 Card'))).toBe(true)
    expect(undid(at('Move Card A', null), at('Move Card A', 'Move Card A'))).toBe(true) // the same Card moved twice
  })
  it('a gesture, a Redo, a step left as it is, a cleared list and a Branch switch do not', () => {
    expect(undid(at('Move 1 Card', null), at('Add Card Drift', null))).toBe(false) // a gesture empties Redo
    expect(undid(at('Add Card Drift', 'Move 1 Card'), at('Move 1 Card', null))).toBe(false) // Redo
    expect(undid(at('Move 1 Card', 'Rename Card A → B'), at('Add Card Drift', 'Rename Card A → B'))).toBe(false) // "Not undone — …"
    expect(undid(at('Move 1 Card', null), at(null, null))).toBe(false) // a Merge or a Restore landed
    expect(undid(at(null, null), at('Add Card Walks', 'Move 1 Card'))).toBe(false) // after the Board closed for a switch
    expect(undid(at('Move 1 Card', null), at('Move 1 Card', null))).toBe(false) // told, but nothing changed
  })
})

describe('what the Undo step sees in the real list of steps', () => {
  it('a slip and its Undo: the gesture is not one, the Undo is', async () => {
    await gesture(ops.move('a', 40, 40))
    await gesture([ops.setStatus('b', 'reading')])
    expect(undos).toBe(0)
    expect((await u.undo())?.done).toBe(true)
    expect(undos).toBe(1)
    expect((await u.undo())?.done).toBe(true) // down to the last step there is
    expect(undos).toBe(2)
  })

  it('a Redo is not one, nor a new gesture after an Undo', async () => {
    await gesture(ops.move('a', 40, 40))
    await u.undo()
    expect(undos).toBe(1)
    expect((await u.redo())?.done).toBe(true)
    await gesture(ops.move('b', 10, 10))
    expect(undos).toBe(1)
  })

  it('an Undo that left everything as someone else made it is not one', async () => {
    await gesture([ops.setText('a', 'title', 'Axion')])
    ws.receive(server.external([ops.setText('a', 'title', 'Axion field')], ANA.id))
    await settle()
    expect(await u.undo()).toEqual({ done: false, note: 'Not undone — Ana changed this since.' })
    expect(undos).toBe(0)
  })

  it('nothing to undo is not one, nor a Restore emptying the list', async () => {
    expect((await u.undo())?.done).toBe(false)
    await gesture([ops.setStatus('a', 'reading')])
    ws.receive(server.frameFor(server.restore(0, ANA.id)))
    await settle()
    expect(u.current()).toEqual({ undo: null, redo: null })
    expect(undos).toBe(0)
  })

  it('switching to a Branch whose list has an undone step is not one', async () => {
    await gesture([ops.setStatus('a', 'reading')])
    server.fork('try', { branch: 'main-id', seq: server.seq })
    await openLive('try')
    await gesture([ops.setStatus('b', 'understood')])
    await gesture([ops.setStatus('a', 'understood')])
    await u.undo() // on try: one Undo
    expect(undos).toBe(1)
    await openLive('main')
    await openLive('try') // back to a list with something to redo
    expect(u.current()).toEqual({ undo: 'Status: Bosons → Understood', redo: 'Status: Axions → Understood' })
    expect(undos).toBe(1)
  })
})
