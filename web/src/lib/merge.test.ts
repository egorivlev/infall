import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBoardSync } from './board-sync'
import { branchesStore } from './branches-store'
import { ApiError } from './http'
import { createMerge } from './merge'
import { ops } from './ops'
import { membersStore } from './people'
import { sessionStore } from './session-store'
import { FakeServer, FakeSocket, FakeTimers, GUEST, ME, OTHER, settle } from './testing'
import type { Conflict, MergePlan, Op, Value } from './types'

let server: FakeServer
let timers: FakeTimers
let sync: ReturnType<typeof createBoardSync>
let merge: ReturnType<typeof createMerge>

const snap = () => merge.store.getState().snapshot
const board = () => sync.store.getState().snapshot
const sent = (method: string, needle: string) => server.requests.filter((r) => r.method === method && r.path.includes(needle))
const T = (s: string): Value => ({ Text: s })
const card = (id: string, title?: string): Op => ops.createCard({ id, x: 0, y: 0, title })
const field = (entity: string, name: string, base: Value, source: Value, target: Value): Conflict => ({
  Field: { entity, field: name, base, source, target },
})

const TITLE = field('a', 'title', T('Alpha'), T('Alpha S'), T('Alpha T'))
const SUMMARY = field('b', 'summary', 'Null', T('From try'), T('From main'))
const STATUS = field('c', 'status', 'Null', T('understood'), T('dead_end'))

// main: Alpha, Beta, Gamma and Alpha → Beta. `try` forks there; both then change the same things.
// The scripted plan: one new Card and one Status land by themselves; three Conflicts.
function scene() {
  server.now = 100
  server.commit([card('a', 'Alpha'), card('b', 'Beta'), card('c', 'Gamma'), ops.createConnection({ id: 'k', from: 'a', to: 'b' })], ME.id)
  server.fork('try', { branch: 'main-id', seq: 4 })
  server.now = 200
  server.commit(
    [
      ops.setText('a', 'title', 'Alpha S'),
      ops.setText('b', 'summary', 'From try'),
      ops.setStatus('c', 'understood'),
      card('n', 'New'),
      ops.setStatus('b', 'reading'),
    ],
    OTHER.id,
    'try',
  )
  server.now = 300
  server.commit([ops.setText('a', 'title', 'Alpha T'), ops.setText('b', 'summary', 'From main'), ops.setStatus('c', 'dead_end')], ME.id)
  server.mergeScript = { auto: [card('n', 'New'), ops.setStatus('b', 'reading')], conflicts: [TITLE, SUMMARY, STATUS] }
}

async function rejection(p: Promise<unknown>): Promise<ApiError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  )
  if (!(e instanceof ApiError)) throw new Error('expected an ApiError')
  return e
}

function decideAll() {
  merge.decide('a:title', 'source')
  merge.decide('b:summary', 'target')
  merge.decide('c:status', 'source')
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
  merge = createMerge(sync)
  scene()
})

afterEach(() => {
  sync.close()
  vi.unstubAllGlobals()
})

describe('merge.open', () => {
  it('plans the Merge and shows what lands by itself and what must be decided', async () => {
    expect(snap().status).toBe('idle')
    const opening = merge.open('try', 'main')
    expect(snap().status).toBe('loading')
    await opening
    const s = snap()
    expect(s).toMatchObject({
      status: 'ready',
      source: { id: 'try-id', name: 'try', seq: 5 },
      target: { id: 'main-id', name: 'main', seq: 7 },
      auto: [
        { kind: 'Card added', what: 'New' },
        { kind: 'Change', what: 'Beta · status' },
      ],
      autoSummary: '2 Changes · 1 Card added, 1 other Change',
      layoutKept: 0,
      decided: 0,
      nothingToMerge: false,
      checkpointName: 'Before merging try',
      replanned: false,
    })
    expect(s.error).toBeUndefined()
    expect(s.result).toBeUndefined()
    expect(s.conflicts.map((c) => [c.id, c.headline, c.source.text, c.target.text, c.choice])).toEqual([
      ['a:title', 'Title changed on both', 'Alpha S', 'Alpha T', null],
      ['b:summary', 'Summary changed on both', 'From try', 'From main', null],
      ['c:status', 'Status changed on both', 'Understood', 'Dead end', null],
    ])
  })

  it('says who last changed each side on its Branch, and when', async () => {
    await merge.open('try', 'main')
    const title = snap().conflicts[0]!
    expect(title.source).toEqual({ text: 'Alpha S', author: OTHER.id, at: 200 })
    expect(title.target).toEqual({ text: 'Alpha T', author: ME.id, at: 300 })
    expect(snap().conflicts[2]!.source.status).toBe('understood')
  })

  it('asks for the Branches by id, each thing once, and fills the Branch list', async () => {
    await merge.open('try', 'main')
    expect(server.requests.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      [
        'GET /api/branches',
        'GET /api/merges/plan?source=try-id&target=main-id',
        'GET /api/branches/try-id/board',
        'GET /api/branches/main-id/board',
        'GET /api/branches/main-id/checkpoints',
        'GET /api/branches/try-id/changes?after=0',
        'GET /api/branches/main-id/changes?after=0',
      ].sort(),
    )
    expect(branchesStore.getState().branches.map((b) => b.name)).toEqual(['main', 'try'])
  })

  it('works the other way round: the parent into its child', async () => {
    server.mergeScript = { auto: [], conflicts: [field('a', 'title', T('Alpha'), T('Alpha T'), T('Alpha S'))] }
    await merge.open('main', 'try')
    expect(snap()).toMatchObject({ status: 'ready', source: { name: 'main' }, target: { name: 'try' }, checkpointName: 'Before merging main' })
    expect(snap().conflicts[0]!.source).toEqual({ text: 'Alpha T', author: ME.id, at: 300 })
    expect(snap().conflicts[0]!.target).toEqual({ text: 'Alpha S', author: OTHER.id, at: 200 })
  })

  it('loads the base Board for edit vs delete, and titles an entity deleted on one side', async () => {
    server.commit([ops.remove('c')], OTHER.id, 'try')
    server.mergeScript = { auto: [], conflicts: [{ EditVsDelete: { entity: 'c', deleted_on: 'Source' } }] }
    await merge.open('try', 'main')
    expect(sent('GET', '/api/branches/main-id/board?at=4')).toHaveLength(1)
    expect(snap().conflicts[0]).toMatchObject({
      id: 'c:',
      type: 'edit_vs_delete',
      entityTitle: 'Gamma',
      headline: 'Deleted on try, edited on main',
      source: { text: 'Delete the Card', author: OTHER.id, at: 300 },
      target: { text: 'Keep the Card with its edits: status', author: ME.id, at: 300 },
      canEdit: false,
    })
  })

  it('shows the other direction of edit vs delete, and "kept" when a Delete made by hand would be reversed', async () => {
    server.commit([ops.remove('b'), ops.remove('k')], ME.id)
    server.mergeScript = { auto: [], conflicts: [{ EditVsDelete: { entity: 'b', deleted_on: 'Target' } }] }
    await merge.open('try', 'main')
    expect(snap().conflicts[0]).toMatchObject({
      headline: 'Deleted on main, edited on try',
      source: { text: 'Bring back the Card with its edits: status, summary' },
      target: { text: 'Leave the Card deleted', author: ME.id },
    })
    // The base moved to where both already had Beta as `try` has it now: nothing was edited since.
    server.mergeScript = { ...server.mergeScript, base: { branch: 'try-id', seq: 5 } }
    await merge.open('try', 'main')
    expect(sent('GET', '/api/branches/try-id/board?at=5')).toHaveLength(1)
    expect(snap().conflicts[0]).toMatchObject({
      headline: 'Deleted on main, kept on try',
      source: { text: 'Bring back the Card' },
    })
  })

  it('still plans when the base Board cannot be loaded', async () => {
    server.mergeScript = { auto: [], conflicts: [{ EditVsDelete: { entity: 'c', deleted_on: 'Source' } }], base: { branch: 'main-id', seq: 99 } }
    await merge.open('try', 'main')
    expect(snap().status).toBe('ready')
    expect(snap().conflicts[0]!.headline).toBe('Deleted on try, edited on main')
  })

  it('counts layout that stays as the target has it', async () => {
    server.commit([...ops.move('a', 50, 50), ...ops.move('b', 60, 60)], OTHER.id, 'try')
    server.commit(ops.move('a', 70, 70), ME.id)
    server.mergeScript = { auto: ops.move('b', 60, 60), conflicts: [] }
    await merge.open('try', 'main')
    expect(snap()).toMatchObject({ layoutKept: 1, auto: [], autoSummary: '1 moved or resized', nothingToMerge: false })
  })

  it('says when there is nothing to merge', async () => {
    server.mergeScript = { auto: [], conflicts: [] }
    await merge.open('try', 'main')
    expect(snap()).toMatchObject({ status: 'ready', nothingToMerge: true, autoSummary: 'Nothing to merge automatically', auto: [], conflicts: [] })
  })

  it('makes the default Checkpoint name unique on the target', async () => {
    server.checkpoint('Before merging try', 2)
    server.checkpoint('Before merging try', 1, ME.id, 'try') // on the source: does not matter
    await merge.open('try', 'main')
    expect(snap().checkpointName).toBe('Before merging try (2)')
    server.checkpoint('Before merging try (2)')
    await merge.open('try', 'main')
    expect(snap().checkpointName).toBe('Before merging try (3)')
  })

  it('reads the Boards at the planned moments when a Branch moved meanwhile', async () => {
    const planned: MergePlan = server.planFor('try', 'main')
    server.commit([ops.setText('a', 'title', 'Alpha S later')], OTHER.id, 'try')
    server.planFor = () => planned
    await merge.open('try', 'main')
    expect(sent('GET', '/api/branches/try-id/board?at=5')).toHaveLength(1)
    expect(sent('GET', '/api/branches/main-id/board?at=')).toHaveLength(0)
    expect(snap().conflicts[0]!.entityTitle).toBe('Alpha S')
    expect(snap().source!.seq).toBe(5)
  })

  it('plans without authors when the Changes cannot be loaded', async () => {
    server.failChanges = true
    await merge.open('try', 'main')
    expect(snap().status).toBe('ready')
    expect(snap().conflicts[0]!.source).toEqual({ text: 'Alpha S' })
  })

  it('lands not_parent_and_child in the snapshot', async () => {
    server.fork('deep', { branch: 'try-id', seq: 1 })
    await expect(merge.open('deep', 'main')).resolves.toBeUndefined()
    expect(snap()).toMatchObject({
      status: 'error',
      errorCode: 'not_parent_and_child',
      error: 'A Branch can only be merged with the Branch it was made from.',
      source: { name: 'deep' },
      target: { name: 'main' },
      conflicts: [],
    })
  })

  it('lands an unknown Branch in the snapshot without planning', async () => {
    await merge.open('nope', 'main')
    expect(snap()).toMatchObject({ status: 'error', errorCode: 'not_found', error: 'There is no Branch named nope.' })
    await merge.open('try', 'gone')
    expect(snap()).toMatchObject({ status: 'error', errorCode: 'not_found', error: 'There is no Branch named gone.' })
    expect(sent('GET', '/api/merges/plan')).toHaveLength(0)
  })

  it('lands a network failure in the snapshot', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')))
    await expect(merge.open('try', 'main')).resolves.toBeUndefined()
    expect(snap()).toMatchObject({ status: 'error', errorCode: 'network', error: 'Cannot reach the server.' })
  })

  it('refuses a Guest without a request', async () => {
    sessionStore.setState({ status: 'signed_in', member: GUEST }, true)
    await merge.open('try', 'main')
    expect(snap()).toMatchObject({ status: 'error', errorCode: 'forbidden', error: 'Guests cannot merge Branches.' })
    expect(server.requests).toHaveLength(0)
    expect((await rejection(merge.apply())).code).toBe('forbidden')
    expect(server.requests).toHaveLength(0)
  })
})

describe('merge.close and late answers', () => {
  it('close() goes back to idle', async () => {
    const idle = snap()
    await merge.open('try', 'main')
    merge.decide('a:title', 'source')
    merge.close()
    expect(snap()).toBe(idle)
    expect(snap()).toMatchObject({ status: 'idle', conflicts: [], auto: [], decided: 0, checkpointName: '' })
    expect(snap().source).toBeUndefined()
  })

  it('ignores an answer that arrives after close()', async () => {
    let release = () => {}
    server.mergeGate = new Promise<void>((r) => (release = r))
    const opening = merge.open('try', 'main')
    await settle()
    expect(snap().status).toBe('loading')
    merge.close()
    release()
    await opening
    expect(snap().status).toBe('idle')
  })

  it('ignores an answer that arrives after a newer open()', async () => {
    let release = () => {}
    server.mergeGate = new Promise<void>((r) => (release = r))
    const first = merge.open('try', 'main')
    await settle()
    server.mergeGate = null
    await merge.open('main', 'try')
    expect(snap()).toMatchObject({ status: 'ready', source: { name: 'main' } })
    const now = snap()
    release()
    await first
    expect(snap()).toBe(now)
  })

  it('ignores the answer to apply() after close(), though the Merge happened', async () => {
    await merge.open('try', 'main')
    decideAll()
    let release = () => {}
    server.mergeGate = new Promise<void>((r) => (release = r))
    const applying = merge.apply()
    expect(snap().status).toBe('applying')
    merge.close()
    release()
    await applying
    expect(snap().status).toBe('idle')
  })

  it('resets when the session ends', async () => {
    await merge.open('try', 'main')
    sessionStore.setState({ status: 'signed_out' }, true)
    expect(snap().status).toBe('idle')
  })
})

describe('merge.decide and setCheckpointName', () => {
  beforeEach(async () => {
    await merge.open('try', 'main')
  })

  it('records, replaces and clears a choice', () => {
    const before = snap()
    merge.decide('a:title', 'source')
    expect(snap().conflicts[0]!.choice).toBe('source')
    expect(snap().decided).toBe(1)
    expect(snap().conflicts[1]).toBe(before.conflicts[1]) // untouched Conflicts keep their identity
    merge.decide('a:title', { custom: 'Alpha both' })
    expect(snap().conflicts[0]!.choice).toEqual({ custom: 'Alpha both' })
    merge.decide('b:summary', 'target')
    expect(snap().decided).toBe(2)
    merge.decide('a:title', null)
    expect(snap().conflicts[0]!.choice).toBeNull()
    expect(snap().decided).toBe(1)
  })

  it('ignores an unknown Conflict and a hand-written value where it is not allowed', () => {
    const before = snap()
    merge.decide('zzz:title', 'source')
    merge.decide('c:status', { custom: 'understood' })
    expect(snap()).toBe(before)
  })

  it('keeps a Checkpoint name typed by hand', () => {
    const before = snap()
    merge.setCheckpointName('Before merging try')
    expect(snap()).toBe(before)
    merge.setCheckpointName('Safe point')
    expect(snap().checkpointName).toBe('Safe point')
  })
})

describe('merge.apply', () => {
  beforeEach(async () => {
    await merge.open('try', 'main')
  })

  it('posts the plan, the Decisions and the Checkpoint name, then shows the result', async () => {
    const plan = server.planFor('try', 'main')
    merge.decide('a:title', 'source')
    merge.decide('b:summary', { custom: 'Both views' })
    merge.decide('c:status', 'target')
    const applying = merge.apply()
    expect(snap().status).toBe('applying')
    await applying
    expect(server.mergePosts).toEqual([
      {
        plan,
        decisions: [
          [{ entity: 'a', field: 'title' }, 'TakeSource'],
          [{ entity: 'b', field: 'summary' }, { Custom: { Text: 'Both views' } }],
          [{ entity: 'c', field: 'status' }, 'TakeTarget'],
        ],
        checkpoint: 'Before merging try',
      },
    ])
    expect(sent('POST', '/api/merges')[0]!.path).toBe('/api/merges')
    const s = snap()
    expect(s.status).toBe('merged')
    // Card n, Beta's Status, Alpha's title, Beta's summary.
    expect(s.result).toEqual({ seq: 11, changes: 4, checkpoint: { name: 'Before merging try', moment: { branch: 'main-id', seq: 7 }, author: ME.id, at: 300 } })
    expect(s.target).toMatchObject({ seq: 11, checkpoints: 1 })
    expect(server.find('main').entities.a!.fields.title).toEqual(T('Alpha S'))
    expect(server.find('main').entities.b!.fields.summary).toEqual(T('Both views'))
    expect(server.log[10]!.origin).toMatchObject({ Merge: { source: { branch: 'try-id', seq: 5 } } })
  })

  it('refreshes the Branch list after the Merge', async () => {
    decideAll()
    await merge.apply()
    expect(sent('GET', '/api/branches').filter((r) => r.path === '/api/branches')).toHaveLength(2)
    expect(branchesStore.getState().branches.find((b) => b.name === 'main')).toMatchObject({ seq: 11, checkpoints: 1 })
  })

  it('sends an empty hand-written value as Null and trims the Checkpoint name', async () => {
    decideAll()
    merge.decide('b:summary', { custom: '' })
    merge.setCheckpointName('  Safe point ')
    await merge.apply()
    expect(server.mergePosts[0]!.decisions[1]).toEqual([{ entity: 'b', field: 'summary' }, { Custom: 'Null' }])
    expect(server.mergePosts[0]!.checkpoint).toBe('Safe point')
    expect(server.find('main').entities.b!.fields.summary).toBeUndefined()
  })

  it('rejects locally while a Conflict is undecided', async () => {
    merge.decide('a:title', 'source')
    const e = await rejection(merge.apply())
    expect(e).toMatchObject({ status: 400, code: 'undecided' })
    expect(e.detail).toEqual([
      { entity: 'b', field: 'summary' },
      { entity: 'c', field: 'status' },
    ])
    expect(server.mergePosts).toHaveLength(0)
    expect(snap().status).toBe('ready')
  })

  it('rejects locally without a Checkpoint name', async () => {
    decideAll()
    merge.setCheckpointName('   ')
    expect(await rejection(merge.apply())).toMatchObject({ status: 400, code: 'bad_request' })
    expect(server.mergePosts).toHaveLength(0)
  })

  it('rejects when nothing is ready', async () => {
    merge.close()
    expect((await rejection(merge.apply())).code).toBe('not_ready')
  })

  it('on stale: plans again, keeps the choices that still fit, drops the others, and rejects', async () => {
    decideAll()
    // `try` gains a Change: Alpha's title there is different now. The other two Conflicts are as before.
    server.now = 400
    server.commit([ops.setText('a', 'title', 'Alpha S2')], OTHER.id, 'try')
    server.mergeScript = {
      auto: server.mergeScript.auto,
      conflicts: [field('a', 'title', T('Alpha'), T('Alpha S2'), T('Alpha T')), SUMMARY, STATUS],
    }
    const e = await rejection(merge.apply())
    expect(e).toMatchObject({ status: 409, code: 'stale' })
    const s = snap()
    expect(s).toMatchObject({ status: 'ready', replanned: true, decided: 2, source: { seq: 6 } })
    expect(s.conflicts.map((c) => [c.id, c.source.text, c.choice])).toEqual([
      ['a:title', 'Alpha S2', null],
      ['b:summary', 'From try', 'target'],
      ['c:status', 'Understood', 'source'],
    ])
    expect(s.conflicts[0]!.source).toMatchObject({ author: OTHER.id, at: 400 })
    // Only the new Changes were fetched.
    expect(sent('GET', '/api/branches/try-id/changes').map((r) => r.path)).toEqual([
      '/api/branches/try-id/changes?after=0',
      '/api/branches/try-id/changes?after=5',
    ])
    expect(sent('GET', '/api/branches/main-id/changes')).toHaveLength(2)
    // The next decision clears the notice; the Merge then goes through with the new plan.
    merge.decide('a:title', 'target')
    expect(snap().replanned).toBe(false)
    await merge.apply()
    expect(snap().status).toBe('merged')
    expect(server.mergePosts).toHaveLength(2)
    expect(server.mergePosts[1]!.plan.source.seq).toBe(6)
  })

  it('on stale: drops a choice whose Conflict is gone and leaves new Conflicts undecided', async () => {
    decideAll()
    server.commit([ops.setText('b', 'summary', 'From main')], OTHER.id, 'try')
    server.mergeScript = { auto: [], conflicts: [TITLE, field('k', 'label', 'Null', T('x'), T('y'))] }
    expect((await rejection(merge.apply())).code).toBe('stale')
    expect(snap().conflicts.map((c) => [c.id, c.choice])).toEqual([
      ['a:title', 'source'],
      ['k:label', null],
    ])
    expect(snap()).toMatchObject({ status: 'ready', replanned: true, decided: 1, autoSummary: 'Nothing to merge automatically' })
  })

  it('on stale: keeps a Checkpoint name typed by hand, renews the default one', async () => {
    decideAll()
    server.checkpoint('Before merging try')
    server.mergeFail = { status: 409, code: 'stale' }
    await rejection(merge.apply())
    expect(snap().checkpointName).toBe('Before merging try (2)')
    merge.setCheckpointName('Mine')
    server.checkpoint('Mine')
    server.mergeFail = { status: 409, code: 'stale' }
    await rejection(merge.apply())
    expect(snap().checkpointName).toBe('Mine')
    expect(snap().decided).toBe(3)
  })

  it('on stale: an error while planning again lands in the snapshot', async () => {
    decideAll()
    server.mergeFail = { status: 409, code: 'stale' }
    const real = server.fetch
    vi.stubGlobal('fetch', (path: string, init?: RequestInit) =>
      path.startsWith('/api/merges/plan') ? Promise.reject(new TypeError('offline')) : real(path, init),
    )
    expect((await rejection(merge.apply())).code).toBe('stale')
    expect(snap()).toMatchObject({ status: 'error', errorCode: 'network', source: { name: 'try' } })
  })

  it('on name_taken: back to ready with the choices, and rejects', async () => {
    decideAll()
    server.checkpoint('Before merging try')
    const e = await rejection(merge.apply())
    expect(e).toMatchObject({ status: 409, code: 'name_taken' })
    expect(snap()).toMatchObject({ status: 'ready', decided: 3, replanned: false, checkpointName: 'Before merging try' })
    expect(server.find('main').log).toHaveLength(7)
    merge.setCheckpointName('Another name')
    await merge.apply()
    expect(snap().status).toBe('merged')
  })

  it('on undecided from the server, or a network failure: back to ready, and rejects', async () => {
    decideAll()
    server.mergeFail = { status: 400, code: 'undecided', detail: [{ entity: 'a', field: 'title' }] }
    const e = await rejection(merge.apply())
    expect(e).toMatchObject({ status: 400, code: 'undecided', detail: [{ entity: 'a', field: 'title' }] })
    expect(snap()).toMatchObject({ status: 'ready', decided: 3 })
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')))
    expect(await rejection(merge.apply())).toMatchObject({ status: 0, code: 'network' })
    expect(snap()).toMatchObject({ status: 'ready', decided: 3 })
  })

  it('gives the Merge to the open Board when it shows the target', async () => {
    await sync.open('main')
    const ws = FakeSocket.last()
    ws.open()
    ws.receive({ type: 'subscribed', branch: 'main-id', seq: 7 })
    await settle()
    expect(board().cards.map((c) => c.id)).toEqual(['a', 'b', 'c'])
    decideAll()
    await merge.apply()
    expect(board().cards.map((c) => c.id)).toEqual(['a', 'b', 'c', 'n'])
    expect(board().seq).toBe(11)
    expect(board().cards[0]!.title).toBe('Alpha S')
    expect(board().branch).toMatchObject({ checkpoints: 1 })
  })

  it('leaves the open Board alone when it shows another Branch', async () => {
    await sync.open('try')
    const ws = FakeSocket.last()
    ws.open()
    ws.receive({ type: 'subscribed', branch: 'try-id', seq: 5 })
    await settle()
    decideAll()
    await merge.apply()
    expect(board().seq).toBe(5)
    expect(board().cards[0]!.title).toBe('Alpha S')
  })

  it('merges a plan with nothing in it', async () => {
    server.mergeScript = { auto: [], conflicts: [] }
    await merge.open('try', 'main')
    await merge.apply()
    expect(snap()).toMatchObject({ status: 'merged', result: { seq: 7, changes: 0 } })
    expect(server.mergePosts[0]!.decisions).toEqual([])
  })
})

describe('merge.refresh', () => {
  it('plans again, keeping choices that still fit; says so only when the plan changed', async () => {
    await merge.open('try', 'main')
    decideAll()
    merge.setCheckpointName('Mine')
    const before = server.requests.length
    await merge.refresh()
    expect(snap()).toMatchObject({ status: 'ready', decided: 3, replanned: false, checkpointName: 'Mine' })
    expect(sent('GET', '/api/branches').filter((r) => r.path === '/api/branches')).toHaveLength(1)
    expect(server.requests.length - before).toBe(6)

    server.commit([ops.setStatus('c', 'reading')], ME.id)
    server.mergeScript = { auto: server.mergeScript.auto, conflicts: [TITLE, SUMMARY, field('c', 'status', 'Null', T('understood'), T('reading'))] }
    const refreshing = merge.refresh()
    expect(snap().status).toBe('loading')
    expect(snap().conflicts).toHaveLength(3) // the review stays visible meanwhile
    await refreshing
    expect(snap()).toMatchObject({ status: 'ready', decided: 2, replanned: true, target: { seq: 8 } })
    expect(snap().conflicts[2]).toMatchObject({ choice: null, target: { text: 'Reading' } })
  })

  it('starts over after an error, and does nothing while idle', async () => {
    await merge.refresh()
    expect(server.requests).toHaveLength(0)
    server.failNext = null
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')))
    await merge.open('try', 'main')
    expect(snap().status).toBe('error')
    vi.stubGlobal('fetch', server.fetch)
    await merge.refresh()
    expect(snap()).toMatchObject({ status: 'ready', decided: 0 })
  })

  it('lands a failure in the snapshot', async () => {
    await merge.open('try', 'main')
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')))
    await expect(merge.refresh()).resolves.toBeUndefined()
    expect(snap()).toMatchObject({ status: 'error', errorCode: 'network', source: { name: 'try' }, target: { name: 'main' } })
  })
})
